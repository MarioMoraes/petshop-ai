import { withTenant, type Pet, type Prisma, type TenantTransaction } from '@petshop/db'
import {
  PET_ROUTING_KEYS,
  birthDateFromEstimatedAge,
  type CreatePetInput,
  type ListPetsQuery,
  type PaginatedPets,
  type PetResponse,
  type PetSensitive,
  type PetWeightRecord,
  type UpdatePetInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { conflict, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { recordMetric } from '../../lib/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet, invalidatePet } from '../../lib/redis.js'
import { loadDomainRefs } from '../catalog/service.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { hashMicrochip, openCipher, type PetCipher } from './crypto.js'
import { enrichPets, toPetResponse, type PetRow } from './mapper.js'
import { searchPetIds } from './search.js'
import { linkTutorsIn } from './tutors.js'
import { latestWeightBefore, publishWeightRecorded, toRecord } from './weights.js'

/**
 * CRUD do pet (MOD-PET-01).
 *
 * Toda escrita roda em uma transação com contexto de tenant: pet, vínculos, primeira
 * pesagem e auditoria caem juntos ou não caem. Um pet gravado sem responsável seria
 * um animal sem quem responda por ele — exatamente o que MOD-PET-02 existe para
 * impedir, e não algo a ser corrigido depois por rotina de reparo.
 */

/**
 * Relações carregadas em toda leitura: sem elas o contrato do §5 não fecha.
 *
 * `satisfies`, e não `as const`: o `orderBy` de um include precisa ser mutável para o
 * Prisma, e o readonly do `as const` não casa com o tipo dele.
 */
export const WITH_DOMAIN = {
  species: true,
  breed: true,
  size: true,
  coat: true,
  petTutors: {
    where: { unlinkedAt: null },
    include: { tutor: true },
    orderBy: [{ role: 'asc' }, { linkedAt: 'asc' }],
  },
} satisfies Prisma.PetInclude

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function listPets(tenantId: string, query: ListPetsQuery): Promise<PaginatedPets> {
  const startedAt = Date.now()

  const result = await withTenant(tenantId, async (tx) => {
    const { ids, total } = await searchPetIds(tx, query)
    if (ids.length === 0) return { data: [], total, page: query.page, limit: query.limit }

    const rows = await tx.pet.findMany({ where: { id: { in: ids } }, include: WITH_DOMAIN })
    const cipher = await openCipher(tx, tenantId)

    // `findMany` não preserva a ordem do `IN`; a relevância veio do SQL de busca.
    const byId = new Map(rows.map((row) => [row.id, row]))
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined)

    return {
      data: await enrichPets(
        tx,
        ordered,
        ordered.map((row) => toPetResponse(row, cipher)),
      ),
      total,
      page: query.page,
      limit: query.limit,
    }
  })

  recordMetric({ metric: 'pet_search_latency', tenantId, value: Date.now() - startedAt, unit: 'ms' })
  return result
}

export async function getPet(tenantId: string, petId: string): Promise<PetResponse> {
  const cached = await cacheGet<PetResponse>(CACHE_KEYS.pet(tenantId, petId))
  if (cached) return cached

  const pet = await withTenant(tenantId, async (tx) => {
    const row = await tx.pet.findFirst({ where: { id: petId, deletedAt: null }, include: WITH_DOMAIN })
    if (!row) throw notFound()
    const cipher = await openCipher(tx, tenantId)
    const [mapped] = await enrichPets(tx, [row], [toPetResponse(row, cipher)])
    return mapped as PetResponse
  })

  await cacheSet(CACHE_KEYS.pet(tenantId, petId), pet, CACHE_TTL_SECONDS.pet)
  return pet
}

/**
 * Microchip inteiro, sem máscara. Cada leitura vira `pet.microchip_revealed`: o
 * número é identificador rastreável do animal, e exibi-lo é evento, não detalhe de
 * tela (§9).
 */
export async function revealMicrochip(actor: ActorContext, petId: string): Promise<PetSensitive> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!row) throw notFound()

      const cipher = await openCipher(tx, actor.tenantId)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.microchip_revealed',
        entity: 'pet',
        entityId: petId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { microchip: row.microchipEncrypted ? cipher.decrypt(row.microchipEncrypted) : null }
    },
    tenantOptions(actor),
  )
}

// ─── Criação ─────────────────────────────────────────────────────────────────

export async function createPet(actor: ActorContext, input: CreatePetInput): Promise<PetResponse> {
  let firstWeighing: PetWeightRecord | null = null

  const pet = await withTenant(
    actor.tenantId,
    async (tx) => {
      const refs = await loadDomainRefs(tx, input, { breedMustBeSelectable: true })
      const cipher = await openCipher(tx, actor.tenantId)

      const microchipHash = input.microchip ? hashMicrochip(input.microchip) : null
      if (microchipHash) await assertMicrochipFree(tx, microchipHash)

      const birth = resolveBirthDate(input)

      const created = await tx.pet.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          speciesId: refs.species.id,
          breedId: refs.breed?.id ?? null,
          sizeId: refs.size.id,
          coatId: refs.coat?.id ?? null,
          sex: input.sex,
          birthDate: birth.date,
          birthDatePrecision: birth.precision,
          weightKg: input.weightKg ?? null,
          neutered: input.neutered ?? null,
          microchipEncrypted: input.microchip ? cipher.encrypt(input.microchip) : null,
          microchipHash,
          color: input.color ?? null,
          notesEncrypted: input.notes ? cipher.encrypt(input.notes) : null,
          status: 'ACTIVE',
          createdBy: actor.actorUserId ?? null,
        },
      })

      await linkTutorsIn(tx, {
        tenantId: actor.tenantId,
        petId: created.id,
        actorUserId: actor.actorUserId,
        tutors: input.tutors,
      })

      // AC-01: a primeira pesagem entra no histórico já no cadastro. Sem isso a série
      // de RN-10 começaria só na segunda visita, e a comparação de RN-11 não teria
      // ponto de partida.
      if (input.weightKg !== undefined) {
        const weighing = await tx.petWeight.create({
          data: {
            tenantId: actor.tenantId,
            petId: created.id,
            weightKg: input.weightKg,
            measuredBy: actor.actorUserId ?? null,
          },
        })
        firstWeighing = toRecord(weighing, null)
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.created',
        entity: 'pet',
        entityId: created.id,
        after: { name: created.name, speciesId: created.speciesId, status: created.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return reloadPet(tx, created.id, cipher)
    },
    tenantOptions(actor),
  )

  const primaryTutorId = input.tutors.find((tutor) => tutor.role === 'PRIMARY')?.tutorId
  await publishEvent(PET_ROUTING_KEYS.petCriado, {
    tenantId: actor.tenantId,
    petId: pet.id,
    // A chave, não o UUID: quem consome segmenta por espécie, não por id semeado.
    speciesKey: pet.species.key,
    primaryTutorId: primaryTutorId ?? '',
    birthDate: pet.birthDate,
  })
  recordMetric({ metric: 'pet_created_total', tenantId: actor.tenantId, value: 1, unit: 'count' })
  // A pesagem do cadastro é o primeiro ponto da série de RN-10; o prontuário monta a
  // curva a partir dos eventos, e ficar sem este ponto deixaria a linha começando na
  // segunda visita.
  if (firstWeighing) await publishWeightRecorded(actor.tenantId, pet.id, firstWeighing)

  await invalidatePet(actor.tenantId, pet.id, pet.tutors.map((tutor) => tutor.tutorId))
  return pet
}

// ─── Atualização ─────────────────────────────────────────────────────────────

export async function updatePet(
  actor: ActorContext,
  petId: string,
  patch: UpdatePetInput,
): Promise<PetResponse> {
  const changedFields = Object.keys(patch)
  if (changedFields.length === 0) return getPet(actor.tenantId, petId)

  let weighing: PetWeightRecord | null = null

  const pet = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!before) throw notFound()
      assertWritable(before)

      const cipher = await openCipher(tx, actor.tenantId)

      // O catálogo é revalidado sempre que qualquer das quatro referências muda:
      // trocar só a espécie pode deixar a raça anterior órfã de espécie (AC-02).
      const touchesDomain = ['speciesId', 'breedId', 'sizeId', 'coatId'].some(
        (field) => field in patch,
      )
      if (touchesDomain) {
        await loadDomainRefs(
          tx,
          {
            speciesId: patch.speciesId ?? before.speciesId,
            breedId: patch.breedId === undefined ? before.breedId : patch.breedId,
            sizeId: patch.sizeId ?? before.sizeId,
            coatId: patch.coatId === undefined ? before.coatId : patch.coatId,
          },
          // Só quando a raça de fato muda: corrigir o nome de um pet cuja raça foi
          // desativada no meio do caminho não pode virar 422 (AC-04).
          { breedMustBeSelectable: patch.breedId !== undefined && patch.breedId !== before.breedId },
        )
      }

      const microchipHash =
        patch.microchip === undefined ? undefined : patch.microchip ? hashMicrochip(patch.microchip) : null
      if (microchipHash) await assertMicrochipFree(tx, microchipHash, petId)

      const birth = resolveBirthDatePatch(patch)

      const updated = await tx.pet.update({
        where: { id: petId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.speciesId !== undefined ? { speciesId: patch.speciesId } : {}),
          ...(patch.breedId !== undefined ? { breedId: patch.breedId } : {}),
          ...(patch.sizeId !== undefined ? { sizeId: patch.sizeId } : {}),
          ...(patch.coatId !== undefined ? { coatId: patch.coatId } : {}),
          ...(patch.sex !== undefined ? { sex: patch.sex } : {}),
          ...birth,
          ...(patch.weightKg !== undefined ? { weightKg: patch.weightKg } : {}),
          ...(patch.neutered !== undefined ? { neutered: patch.neutered } : {}),
          ...(patch.microchip !== undefined
            ? {
                microchipEncrypted: patch.microchip ? cipher.encrypt(patch.microchip) : null,
                microchipHash,
              }
            : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.notes !== undefined
            ? { notesEncrypted: patch.notes ? cipher.encrypt(patch.notes) : null }
            : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          updatedBy: actor.actorUserId ?? null,
        },
      })

      // RN-10: peso informado no PATCH também entra na série. A coluna `weight_kg`
      // é o denormalizado da última pesagem, não um campo editável à parte.
      if (patch.weightKg !== undefined && patch.weightKg !== null) {
        const measuredAt = new Date()
        const previous = await latestWeightBefore(tx, petId, measuredAt)
        const created = await tx.petWeight.create({
          data: {
            tenantId: actor.tenantId,
            petId,
            weightKg: patch.weightKg,
            measuredAt,
            measuredBy: actor.actorUserId ?? null,
          },
        })
        weighing = toRecord(created, previous)
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.updated',
        entity: 'pet',
        entityId: petId,
        // O diff sai com o microchip redigido pelo `sanitize`: interessa *que* mudou.
        before: pick(before, changedFields),
        after: pick(updated, changedFields),
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return reloadPet(tx, petId, cipher)
    },
    tenantOptions(actor),
  )

  const tutorIds = pet.tutors.map((tutor) => tutor.tutorId)
  await invalidatePet(actor.tenantId, petId, tutorIds)

  await publishEvent(PET_ROUTING_KEYS.petAtualizado, {
    tenantId: actor.tenantId,
    petId,
    changedFields,
  })
  if (patch.status === 'INACTIVE') {
    await publishEvent(PET_ROUTING_KEYS.petInativado, {
      tenantId: actor.tenantId,
      petId,
      lastAttendanceAt: pet.lastAttendanceAt,
    })
  }
  // O peso informado no PATCH é uma pesagem como qualquer outra, com a comparação de
  // RN-11 incluída — o alerta clínico não pode depender de por qual tela o número
  // entrou.
  if (weighing) await publishWeightRecorded(actor.tenantId, petId, weighing)

  return pet
}

// ─── Exclusão ────────────────────────────────────────────────────────────────

/**
 * Soft delete. O índice único do microchip filtra `deleted_at IS NULL`, então o
 * número volta a ficar livre: um cadastro excluído por engano não pode impedir o
 * recadastro do mesmo animal.
 */
export async function deletePet(actor: ActorContext, petId: string): Promise<void> {
  const tutorIds = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!row) throw notFound()

      const links = await tx.petTutor.findMany({
        where: { petId, unlinkedAt: null },
        select: { tutorId: true },
      })

      await tx.pet.update({
        where: { id: petId },
        data: { deletedAt: new Date(), status: 'INACTIVE', updatedBy: actor.actorUserId ?? null },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.deleted',
        entity: 'pet',
        entityId: petId,
        before: { name: row.name, status: row.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return links.map((link) => link.tutorId)
    },
    tenantOptions(actor),
  )

  await invalidatePet(actor.tenantId, petId, tutorIds)

  // O vínculo continua na tabela — o pet foi removido, não transferido —, mas do
  // ponto de vista do tutor ele deixou de responder por um animal. É este evento que
  // o tutor-service usa para recontar `tutors.pets_count`.
  for (const tutorId of tutorIds) {
    await publishEvent(PET_ROUTING_KEYS.petVinculoAlterado, {
      tenantId: actor.tenantId,
      petId,
      tutorId,
      action: 'UNLINKED',
      role: 'SECONDARY',
    })
  }
}

// ─── Regras compartilhadas ───────────────────────────────────────────────────

/** Estados terminais recusam escrita: o pet não é mais deste tenant, ou não vive mais. */
export function assertWritable(row: Pick<Pet, 'status'>): void {
  if (row.status === 'TRANSFERRED_OUT') {
    throw conflict('Este pet foi transferido para outro estabelecimento e não aceita alterações')
  }
  if (row.status === 'DECEASED') {
    throw conflict('Este pet está registrado como falecido. Reverta o óbito para editar.')
  }
}

/** RN-15: 409 carregando o pet existente, para a UI abrir o cadastro em vez de só recusar. */
async function assertMicrochipFree(
  tx: TenantTransaction,
  microchipHash: string,
  excludePetId?: string,
): Promise<void> {
  const existing = await tx.pet.findFirst({
    where: {
      microchipHash,
      deletedAt: null,
      ...(excludePetId ? { id: { not: excludePetId } } : {}),
    },
    select: { id: true, name: true, status: true },
  })
  if (!existing) return

  throw conflict('Já existe um pet com este microchip neste estabelecimento', {
    existingPet: { id: existing.id, name: existing.name, status: existing.status },
  })
}

/**
 * AC-03: pet resgatado entra por idade estimada. A data derivada vai para a mesma
 * coluna `birth_date`, e `birth_date_precision = ESTIMATED` é o que faz a tela
 * exibir "≈ 2 anos" em vez de fingir uma data exata que ninguém conhece.
 */
function resolveBirthDate(input: CreatePetInput): { date: Date | null; precision: 'EXACT' | 'ESTIMATED' | 'UNKNOWN' } {
  if (input.birthDate) return { date: new Date(input.birthDate), precision: 'EXACT' }
  if (input.estimatedAgeMonths !== undefined) {
    return { date: new Date(birthDateFromEstimatedAge(input.estimatedAgeMonths)), precision: 'ESTIMATED' }
  }
  return { date: null, precision: 'UNKNOWN' }
}

/** No PATCH, `null` limpa a data — e limpar a data leva a precisão junto. */
function resolveBirthDatePatch(patch: UpdatePetInput): {
  birthDate?: Date | null
  birthDatePrecision?: 'EXACT' | 'ESTIMATED' | 'UNKNOWN'
} {
  if (patch.birthDate !== undefined) {
    return patch.birthDate
      ? { birthDate: new Date(patch.birthDate), birthDatePrecision: 'EXACT' }
      : { birthDate: null, birthDatePrecision: 'UNKNOWN' }
  }
  if (patch.estimatedAgeMonths !== undefined) {
    return patch.estimatedAgeMonths === null
      ? { birthDate: null, birthDatePrecision: 'UNKNOWN' }
      : {
          birthDate: new Date(birthDateFromEstimatedAge(patch.estimatedAgeMonths)),
          birthDatePrecision: 'ESTIMATED',
        }
  }
  return {}
}

async function reloadPet(tx: TenantTransaction, petId: string, cipher: PetCipher): Promise<PetResponse> {
  const row = await tx.pet.findFirst({ where: { id: petId }, include: WITH_DOMAIN })
  if (!row) throw notFound()
  const [mapped] = await enrichPets(tx, [row], [toPetResponse(row as PetRow, cipher)])
  return mapped as PetResponse
}

function pick(row: Pet, keys: string[]): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}
