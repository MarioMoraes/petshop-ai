import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  formatAgeLabel,
  monthsBetween,
  type PortalPetAlert,
  type PortalPetDetail,
  type PortalPetSummary,
  type PortalNextAppointment,
  type UpdateOwnPetInput,
} from '@petshop/shared-types'
import { notFound } from '../../lib/errors.js'
import { signPhotoUrl, variantKey } from '../../lib/photo-urls.js'
import { openCipher, decryptOptional } from './crypto.js'

/**
 * MOD-PORTAL-03 — os pets do tutor, da perspectiva de quem é dono deles.
 *
 * Toda consulta daqui recebe o `tutorId` do `requireOwnScope`, e não do contexto solto:
 * o handler que ler o escopo sem ter passado pelo gate `_own` não compila. É o RN-02
 * virando mecanismo — "handler que esquece de filtrar não deve ser possível".
 *
 * O recorte é o **vínculo ativo** (`pet_tutors` com `unlinked_at IS NULL`), e não o pet.
 * A diferença é o AC-05: o pet transferido some da lista do tutor anterior no instante
 * em que o vínculo termina, sem que nada precise apagar histórico — os recibos dele
 * continuam no extrato, porque aqueles são fato consumado e não posse atual.
 *
 * A ficha sai **mais pobre** que a do Admin, e de propósito. Microchip não aparece:
 * é identificador de rastreio que a equipe usa e cujo vazamento não tem desfazer.
 * Temperamento não aparece (AC-04 de MOD-PORTAL-04). Peso, porte, raça e pelagem
 * aparecem e não se editam (RN-07).
 */

/** Espécies e portes ficam no catálogo, que muda raramente e é lido em toda listagem. */
const petInclude = {
  species: { select: { label: true } },
  breed: { select: { label: true } },
  size: { select: { label: true } },
  coat: { select: { label: true } },
} as const

/** Estados de agendamento que ainda vão acontecer. Cancelado e concluído não contam. */
const UPCOMING_STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] as const

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function listOwnPets(
  tenantId: string,
  tutorId: string,
): Promise<PortalPetSummary[]> {
  return withTenant(tenantId, async (tx) => {
    const links = await tx.petTutor.findMany({
      where: { tutorId, unlinkedAt: null, pet: { deletedAt: null } },
      select: { pet: { select: { ...petSummarySelect, ...petInclude } } },
    })

    /**
     * `TRANSFERRED_OUT` sai da lista mesmo com vínculo ainda aberto.
     *
     * Não deveria acontecer — a transferência fecha o vínculo —, mas se acontecer, o
     * pet que hoje é de outro estabelecimento não pode aparecer aqui. Duas condições
     * para o mesmo fato é redundância barata do lado certo.
     */
    const pets = links
      .map((link) => link.pet)
      .filter((pet) => pet.status !== 'TRANSFERRED_OUT')
      .sort(byNameThenMemoriam)

    const [photos, upcoming] = await Promise.all([
      coverUrls(tx, pets),
      nextAppointments(
        tx,
        pets.map((pet) => pet.id),
      ),
    ])

    return pets.map((pet) => toSummary(pet, photos.get(pet.id) ?? null, upcoming.get(pet.id) ?? null))
  })
}

export async function readOwnPet(
  tenantId: string,
  tutorId: string,
  petId: string,
): Promise<PortalPetDetail> {
  return withTenant(tenantId, async (tx) => {
    const pet = await findLinkedPet(tx, tutorId, petId)

    const [photos, upcoming, alerts, cipher] = await Promise.all([
      coverUrls(tx, [pet]),
      nextAppointments(tx, [pet.id]),
      readAlerts(tx, pet.id),
      openCipher(tx, tenantId),
    ])

    return {
      ...toSummary(pet, photos.get(pet.id) ?? null, upcoming.get(pet.id) ?? null),
      sex: pet.sex,
      birthDate: pet.birthDate ? toDateString(pet.birthDate) : null,
      birthDatePrecision: pet.birthDatePrecision,
      neutered: pet.neutered,
      notes: decryptOptional(cipher, pet.notesEncrypted),
      color: pet.color,
      weightKg: pet.weightKg === null ? null : Number(pet.weightKg),
      size: pet.size.label,
      coat: pet.coat?.label ?? null,
      alerts,
    }
  })
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

/**
 * AC-02 de MOD-PORTAL-03 — a edição que o tutor pode fazer.
 *
 * O que chega aqui já passou pelo `UpdateOwnPetSchema`, que é a trava do AC-03: peso,
 * porte, raça e pelagem não são recusados por uma checagem, eles não existem no schema.
 *
 * Devolve a ficha recarregada, e não a linha atualizada: a tela que acabou de salvar
 * precisa da idade recalculada e dos alertas, que não saem de um `update`.
 */
export async function updateOwnPet(
  tenantId: string,
  tutorId: string,
  petId: string,
  input: UpdateOwnPetInput,
): Promise<PortalPetDetail> {
  await withTenant(tenantId, async (tx) => {
    const pet = await findLinkedPet(tx, tutorId, petId)

    /**
     * Pet falecido é somente leitura (AC-05).
     *
     * A ficha do que morreu é memória, e memória não se corrige por formulário — quem
     * precisa mexer nela é a equipe, que sabe se houve engano no registro do óbito.
     */
    if (pet.status === 'DECEASED') throw notFound()

    const data: Record<string, unknown> = {}
    if (input.name !== undefined) data.name = input.name

    /**
     * Data de nascimento vem com a **precisão junto**, e não separada.
     *
     * Quem digita a data no Portal é o dono do animal olhando para o documento — isso é
     * `EXACT`. Deixar a precisão como estava manteria "≈ 2 anos" na tela depois de o
     * tutor ter dito exatamente qual é o dia, e a tela passaria a mentir sobre a
     * qualidade do próprio dado.
     */
    if (input.birthDate !== undefined) {
      data.birthDate = input.birthDate ? new Date(`${input.birthDate}T00:00:00Z`) : null
      data.birthDatePrecision = input.birthDate ? 'EXACT' : 'UNKNOWN'
    }

    if (input.neutered !== undefined) data.neutered = input.neutered

    if (input.notes !== undefined) {
      const cipher = await openCipher(tx, tenantId)
      data.notesEncrypted = input.notes ? cipher.encrypt(input.notes) : null
    }

    if (Object.keys(data).length === 0) return

    await tx.pet.update({ where: { id: petId }, data })
  })

  return readOwnPet(tenantId, tutorId, petId)
}

// ─── Peças internas ──────────────────────────────────────────────────────────

const petSummarySelect = {
  id: true,
  name: true,
  status: true,
  sex: true,
  birthDate: true,
  birthDatePrecision: true,
  neutered: true,
  weightKg: true,
  color: true,
  notesEncrypted: true,
  coverPhotoId: true,
  lastAttendanceAt: true,
} as const

/**
 * A linha que o `select` acima produz.
 *
 * Escrita à mão em vez de derivada do Prisma porque o `select` mistura duas fontes — os
 * campos do pet e os quatro rótulos do catálogo —, e o tipo derivado dessa união é
 * ilegível no ponto de uso. Se um campo sair do `select`, o `toSummary` para de compilar.
 */
type PetRow = {
  id: string
  name: string
  status: string
  sex: 'MALE' | 'FEMALE' | 'UNKNOWN'
  birthDate: Date | null
  birthDatePrecision: 'EXACT' | 'ESTIMATED' | 'UNKNOWN'
  neutered: boolean | null
  weightKg: unknown
  color: string | null
  notesEncrypted: string | null
  coverPhotoId: string | null
  lastAttendanceAt: Date | null
  species: { label: string }
  breed: { label: string } | null
  size: { label: string }
  coat: { label: string } | null
}

/**
 * O pet **e o vínculo**, numa consulta só.
 *
 * A ausência responde 404 tanto para o pet que não existe quanto para o que é de outro
 * tutor (RN-03 e AC-03 de MOD-PORTAL-02). São o mesmo caso do lado de fora, e precisam
 * ser o mesmo caso do lado de dentro — um 403 aqui confirmaria que o pet existe.
 */
async function findLinkedPet(
  tx: TenantTransaction,
  tutorId: string,
  petId: string,
): Promise<PetRow> {
  const link = await tx.petTutor.findFirst({
    where: { tutorId, petId, unlinkedAt: null, pet: { deletedAt: null } },
    select: { pet: { select: { ...petSummarySelect, ...petInclude } } },
  })

  if (!link || link.pet.status === 'TRANSFERRED_OUT') throw notFound()
  return link.pet as PetRow
}

function toSummary(
  pet: PetRow,
  photoUrl: string | null,
  nextAppointment: PortalNextAppointment | null,
): PortalPetSummary {
  const ageMonths =
    pet.birthDate && pet.birthDatePrecision !== 'UNKNOWN'
      ? monthsBetween(pet.birthDate, new Date())
      : null

  return {
    id: pet.id,
    name: pet.name,
    species: pet.species.label,
    breed: pet.breed?.label ?? null,
    ageLabel: formatAgeLabel(ageMonths, pet.birthDatePrecision),
    photoUrl,
    inMemoriam: pet.status === 'DECEASED',
    lastAttendanceAt: pet.lastAttendanceAt?.toISOString() ?? null,
    /** Quem morreu não tem próximo agendamento, ainda que uma linha órfã sobrasse. */
    nextAppointment: pet.status === 'DECEASED' ? null : nextAppointment,
  }
}

/** Vivos primeiro, em ordem alfabética; "em memória" fecha a lista. */
function byNameThenMemoriam(a: PetRow, b: PetRow): number {
  const aGone = a.status === 'DECEASED' ? 1 : 0
  const bGone = b.status === 'DECEASED' ? 1 : 0
  if (aGone !== bGone) return aGone - bGone
  return a.name.localeCompare(b.name, 'pt-BR')
}

/** A capa de cada pet, assinada. Uma consulta para a lista inteira. */
async function coverUrls(
  tx: TenantTransaction,
  pets: Pick<PetRow, 'id' | 'coverPhotoId'>[],
): Promise<Map<string, string>> {
  const ids = pets.map((pet) => pet.coverPhotoId).filter((id): id is string => Boolean(id))
  if (ids.length === 0) return new Map()

  const photos = await tx.petPhoto.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, petId: true, variants: true },
  })

  const urls = new Map<string, string>()
  await Promise.all(
    photos.map(async (photo) => {
      const url = await signPhotoUrl(variantKey(photo.variants, 'medium'))
      if (url) urls.set(photo.petId, url)
    }),
  )
  return urls
}

/**
 * O próximo agendamento de cada pet.
 *
 * Uma consulta para a lista toda, ordenada, e o primeiro de cada pet vence. Perguntar
 * por pet faria N+1 numa tela que o tutor abre no 4G — e o SLO desta é de celular.
 */
async function nextAppointments(
  tx: TenantTransaction,
  petIds: string[],
): Promise<Map<string, PortalNextAppointment>> {
  if (petIds.length === 0) return new Map()

  const rows = await tx.appointment.findMany({
    where: {
      petId: { in: petIds },
      startsAt: { gte: new Date() },
      status: { in: [...UPCOMING_STATUSES] },
    },
    orderBy: { startsAt: 'asc' },
    select: {
      id: true,
      petId: true,
      startsAt: true,
      status: true,
      items: { select: { label: true } },
    },
  })

  const next = new Map<string, PortalNextAppointment>()
  for (const row of rows) {
    if (next.has(row.petId)) continue
    next.set(row.petId, {
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      status: row.status,
      services: row.items.map((item) => item.label),
    })
  }
  return next
}

/**
 * Alergias e alertas médicos ativos (AC-04 de MOD-PORTAL-04).
 *
 * A reação e as instruções ficam cifradas e **não saem daqui**: são texto clínico
 * escrito para a equipe executar, e o que o tutor precisa saber é que a alergia existe e
 * quão séria é. `temperaments` não é consultado — nem por engano.
 */
async function readAlerts(tx: TenantTransaction, petId: string): Promise<PortalPetAlert[]> {
  const [allergies, medical] = await Promise.all([
    tx.allergy.findMany({
      where: { petId, active: true },
      select: { label: true, severity: true },
      orderBy: { createdAt: 'asc' },
    }),
    tx.medicalAlert.findMany({
      where: { petId, active: true },
      select: { condition: true, severity: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  return [
    ...allergies.map((row) => ({ kind: 'ALLERGY' as const, label: row.label, severity: row.severity })),
    ...medical.map((row) => ({ kind: 'MEDICAL' as const, label: row.condition, severity: row.severity })),
  ]
}

/** `Date` de coluna `DATE` → `YYYY-MM-DD`, sem deslocar por fuso. */
function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10)
}
