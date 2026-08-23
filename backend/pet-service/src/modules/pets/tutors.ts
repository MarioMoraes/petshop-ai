import { withTenant, type Pet, type TenantTransaction } from '@petshop/db'
import {
  PET_ROUTING_KEYS,
  type LinkTutorInput,
  type PetTutorInput,
  type PetTutorLink,
  type UpdatePetTutorInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { blockedByLink, conflict, invalid, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { invalidatePet } from '../../lib/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { openCipher } from './crypto.js'
import { toPetTutorLink } from './mapper.js'

/**
 * Vínculo N:N pet ↔ tutor (MOD-PET-02).
 *
 * O vínculo encerrado **não** é apagado: `unlinked_at` marca a data e a linha fica.
 * É o histórico de quem respondeu pelo animal e quando — o que a transferência de
 * titularidade (RN-06/RN-07) precisa para preservar os recibos do tutor anterior.
 *
 * RN-04 — exatamente um PRIMARY ativo por pet — é garantido pelo índice único
 * parcial `idx_pet_primary_tutor`. As checagens daqui existem para a mensagem sair
 * legível (AC-02), não para substituir a garantia do banco.
 */

const WITH_TUTOR = { tutor: true } as const

const ACTIVE_LINK_ORDER = [{ role: 'asc' as const }, { linkedAt: 'asc' as const }]

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function listPetTutors(tenantId: string, petId: string): Promise<PetTutorLink[]> {
  return withTenant(tenantId, async (tx) => {
    await loadPet(tx, petId)
    const [links, cipher] = await Promise.all([
      tx.petTutor.findMany({
        where: { petId, unlinkedAt: null },
        include: WITH_TUTOR,
        orderBy: ACTIVE_LINK_ORDER,
      }),
      openCipher(tx, tenantId),
    ])
    return links.map((link) => toPetTutorLink(link, cipher))
  })
}

// ─── Criação de vínculo ──────────────────────────────────────────────────────

/**
 * Cria os vínculos dentro da transação de quem chamou. É o que o `POST /v1/pets`
 * usa: pet e vínculo nascem juntos ou não nascem — um pet sem responsável seria
 * exatamente o estado que AC-03 existe para impedir.
 */
export async function linkTutorsIn(
  tx: TenantTransaction,
  params: { tenantId: string; petId: string; actorUserId?: string | undefined; tutors: PetTutorInput[] },
): Promise<void> {
  await assertTutorsExist(tx, params.tutors.map((tutor) => tutor.tutorId))

  await tx.petTutor.createMany({
    data: params.tutors.map((tutor) => ({
      tenantId: params.tenantId,
      petId: params.petId,
      tutorId: tutor.tutorId,
      role: tutor.role,
      relationship: tutor.relationship ?? null,
      canAuthorizeProcedures: tutor.canAuthorizeProcedures,
      createdBy: params.actorUserId ?? null,
    })),
  })
}

/** AC-01 de MOD-PET-02: o segundo tutor do casal, vinculado depois do cadastro. */
export async function linkTutor(
  actor: ActorContext,
  petId: string,
  input: LinkTutorInput,
): Promise<PetTutorLink> {
  const link = await withTenant(
    actor.tenantId,
    async (tx) => {
      await loadPet(tx, petId)
      await assertTutorsExist(tx, [input.tutorId])

      const existing = await tx.petTutor.findFirst({
        where: { petId, tutorId: input.tutorId, unlinkedAt: null },
      })
      if (existing) {
        throw conflict('Este tutor já está vinculado ao pet', { linkId: existing.id })
      }

      if (input.role === 'PRIMARY') await assertNoPrimary(tx, petId)

      const created = await tx.petTutor.create({
        data: {
          tenantId: actor.tenantId,
          petId,
          tutorId: input.tutorId,
          role: input.role,
          relationship: input.relationship ?? null,
          canAuthorizeProcedures: input.canAuthorizeProcedures,
          createdBy: actor.actorUserId ?? null,
        },
        include: WITH_TUTOR,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.tutor_linked',
        entity: 'pet',
        entityId: petId,
        after: { tutorId: input.tutorId, role: input.role, relationship: input.relationship ?? null },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const cipher = await openCipher(tx, actor.tenantId)
      return toPetTutorLink(created, cipher)
    },
    tenantOptions(actor),
  )

  await invalidatePet(actor.tenantId, petId, [link.tutorId])
  await publishEvent(PET_ROUTING_KEYS.petVinculoAlterado, {
    tenantId: actor.tenantId,
    petId,
    tutorId: link.tutorId,
    action: 'LINKED',
    role: link.role,
  })
  return link
}

// ─── Alteração ───────────────────────────────────────────────────────────────

/**
 * Muda papel, parentesco ou autorização de procedimento.
 *
 * Promover a PRIMARY com outro principal ativo devolve 409: a ordem correta é
 * rebaixar o atual e então promover. Fazer as duas coisas aqui, em silêncio,
 * trocaria o responsável financeiro do pet (RN-05) sem que ninguém tivesse pedido.
 */
export async function updatePetTutor(
  actor: ActorContext,
  petId: string,
  linkId: string,
  patch: UpdatePetTutorInput,
): Promise<PetTutorLink> {
  const changedFields = Object.keys(patch)
  if (changedFields.length === 0) {
    const links = await listPetTutors(actor.tenantId, petId)
    const current = links.find((link) => link.linkId === linkId)
    if (!current) throw notFound('Vínculo não encontrado')
    return current
  }

  const link = await withTenant(
    actor.tenantId,
    async (tx) => {
      await loadPet(tx, petId)
      const before = await tx.petTutor.findFirst({ where: { id: linkId, petId, unlinkedAt: null } })
      if (!before) throw notFound('Vínculo não encontrado')

      if (patch.role === 'PRIMARY' && before.role !== 'PRIMARY') {
        await assertNoPrimary(tx, petId)
      }
      if (patch.role === 'SECONDARY' && before.role === 'PRIMARY') {
        // Rebaixar o principal é o primeiro passo da troca de responsável; o pet
        // fica sem PRIMARY até o segundo PATCH, e isso é aceitável porque o índice
        // parcial só proíbe **dois** principais.
        await assertHasOtherActiveLink(tx, petId, linkId)
      }

      const updated = await tx.petTutor.update({
        where: { id: linkId },
        data: {
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.relationship !== undefined ? { relationship: patch.relationship } : {}),
          ...(patch.canAuthorizeProcedures !== undefined
            ? { canAuthorizeProcedures: patch.canAuthorizeProcedures }
            : {}),
        },
        include: WITH_TUTOR,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        // A troca de principal tem ação própria no §9: é ela que move o débito.
        action: patch.role && patch.role !== before.role ? 'pet.primary_tutor_changed' : 'pet.tutor_updated',
        entity: 'pet',
        entityId: petId,
        before: { tutorId: before.tutorId, role: before.role, relationship: before.relationship },
        after: { tutorId: updated.tutorId, role: updated.role, relationship: updated.relationship },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const cipher = await openCipher(tx, actor.tenantId)
      return toPetTutorLink(updated, cipher)
    },
    tenantOptions(actor),
  )

  await invalidatePet(actor.tenantId, petId, [link.tutorId])
  await publishEvent(PET_ROUTING_KEYS.petVinculoAlterado, {
    tenantId: actor.tenantId,
    petId,
    tutorId: link.tutorId,
    action: 'UPDATED',
    role: link.role,
  })
  return link
}

// ─── Encerramento ────────────────────────────────────────────────────────────

/** AC-03: o último responsável não sai — para isso existe a transferência. */
export async function unlinkTutor(actor: ActorContext, petId: string, linkId: string): Promise<void> {
  const tutorId = await withTenant(
    actor.tenantId,
    async (tx) => {
      await loadPet(tx, petId)
      const link = await tx.petTutor.findFirst({ where: { id: linkId, petId, unlinkedAt: null } })
      if (!link) throw notFound('Vínculo não encontrado')

      const activeCount = await tx.petTutor.count({ where: { petId, unlinkedAt: null } })
      if (activeCount <= 1) {
        throw blockedByLink(
          'O pet precisa de ao menos um responsável. Use a transferência de titularidade.',
          { transferPath: `/v1/pets/${petId}/transfer` },
        )
      }

      await tx.petTutor.update({ where: { id: linkId }, data: { unlinkedAt: new Date() } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.tutor_unlinked',
        entity: 'pet',
        entityId: petId,
        before: { tutorId: link.tutorId, role: link.role },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return link.tutorId
    },
    tenantOptions(actor),
  )

  await invalidatePet(actor.tenantId, petId, [tutorId])
  await publishEvent(PET_ROUTING_KEYS.petVinculoAlterado, {
    tenantId: actor.tenantId,
    petId,
    tutorId,
    action: 'UNLINKED',
    role: 'SECONDARY',
  })
}

// ─── Regras compartilhadas ───────────────────────────────────────────────────

/** Carrega o pet só para provar que ele existe neste tenant antes de mexer no vínculo. */
async function loadPet(tx: TenantTransaction, petId: string): Promise<Pet> {
  const pet = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
  if (!pet) throw notFound()
  return pet
}

/** AC-02: 409 com o principal atual, para a UI oferecer a troca em vez de só recusar. */
async function assertNoPrimary(tx: TenantTransaction, petId: string): Promise<void> {
  const primary = await tx.petTutor.findFirst({
    where: { petId, role: 'PRIMARY', unlinkedAt: null },
  })
  if (!primary) return

  throw conflict(
    'Este pet já possui um responsável principal. Altere o atual antes de definir outro.',
    { currentPrimary: { linkId: primary.id, tutorId: primary.tutorId } },
  )
}

async function assertHasOtherActiveLink(
  tx: TenantTransaction,
  petId: string,
  exceptLinkId: string,
): Promise<void> {
  const other = await tx.petTutor.count({
    where: { petId, unlinkedAt: null, id: { not: exceptLinkId } },
  })
  if (other === 0) {
    throw blockedByLink('O pet precisa de um responsável principal. Vincule outro tutor antes.')
  }
}

/**
 * O tutor precisa existir e estar vivo neste tenant. O RLS já esconderia um tutor de
 * outro estabelecimento, então o erro aqui é de entrada — 422 apontando o campo, e
 * não um 404 que confundiria com o pet.
 */
async function assertTutorsExist(tx: TenantTransaction, tutorIds: string[]): Promise<void> {
  const found = await tx.tutor.findMany({
    where: { id: { in: tutorIds }, deletedAt: null },
    select: { id: true, status: true },
  })
  const byId = new Map(found.map((tutor) => [tutor.id, tutor]))

  for (const tutorId of tutorIds) {
    const tutor = byId.get(tutorId)
    if (!tutor) {
      throw invalid('Tutor não encontrado', [{ field: 'tutorId', message: 'Tutor não encontrado' }])
    }
    if (tutor.status === 'ANONYMIZED' || tutor.status === 'MERGED') {
      throw invalid('Este cadastro de tutor não aceita novos vínculos', [
        { field: 'tutorId', message: 'Cadastro de tutor indisponível' },
      ])
    }
  }
}
