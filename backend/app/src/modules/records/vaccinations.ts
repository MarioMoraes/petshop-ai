import { randomUUID } from 'node:crypto'
import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  OTHER_VACCINE_KEY,
  RECORD_ROUTING_KEYS,
  currentDoses,
  formatCrmv,
  todayIn,
  vaccinationStatus,
  vaccineCatalogFor,
  type CreateVaccinationInput,
  type Vaccination as VaccinationDto,
  type VaccinationCard,
  type VoidVaccinationInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { invalidateSummary } from '../attendances/cache.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { crmvRequired, forbidden, invalid, notFound } from './errors.js'
import { getVaccinationInventoryPort } from './inventory-port.js'

/**
 * A carteira de vacinação (MOD-PRONT-08).
 *
 * Duas portas de entrada com exigências diferentes, na mesma tabela:
 *
 * - **aplicada aqui** (`INTERNAL`): quem assina é o veterinário **logado** — a ficha de
 *   profissional ligada ao usuário, com CRMV —, o mesmo critério do receituário
 *   (`prescriptions/service.ts`). Lote vencido na data da aplicação é recusado (AC-02);
 * - **aplicada fora** (`EXTERNAL`): a carteira de papel que a recepção transcreve. Nada de
 *   rastreabilidade é exigido, porque ninguém aqui a tem.
 *
 * Nada se edita. O que foi lançado errado é anulado com motivo, e o certo entra de novo.
 *
 * **A dose aplicada aqui pode sair do estoque** (Pro): com `lotId`, o lote e a validade
 * gravados são os do lote, e uma unidade é baixada na mesma transação, pela porta
 * `inventory-port.ts`. Anular devolve.
 */

type VaccinationRow = Awaited<ReturnType<TenantTransaction['vaccination']['findFirstOrThrow']>>

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function toVaccination(row: VaccinationRow): VaccinationDto {
  return {
    id: row.id,
    petId: row.petId,
    attendanceId: row.attendanceId,
    origin: row.origin,
    vaccineKey: row.vaccineKey,
    vaccineLabel: row.vaccineLabel,
    appliedAt: isoDate(row.appliedAt),
    nextDoseAt: row.nextDoseAt ? isoDate(row.nextDoseAt) : null,
    manufacturer: row.manufacturer,
    batch: row.batch,
    batchExpiresAt: row.batchExpiresAt ? isoDate(row.batchExpiresAt) : null,
    vetName: row.vetName,
    crmv: row.crmv,
    externalClinic: row.externalClinic,
    createdAt: row.createdAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
  }
}

/** O dia de hoje no relógio do petshop — é contra ele que "atrasada" se decide. */
export async function tenantToday(tx: TenantTransaction): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  return todayIn(settings?.timezone ?? DEFAULT_TIMEZONE)
}

/** A carteira montada a partir das linhas, já ordenadas da mais recente para a mais antiga. */
export function buildCard(rows: readonly VaccinationRow[], today: string): VaccinationCard {
  const history = rows.map(toVaccination)
  const current = currentDoses(history)
  return { status: vaccinationStatus(current, today), today, current, history }
}

export async function loadVaccinations(
  tx: TenantTransaction,
  petId: string,
): Promise<VaccinationRow[]> {
  return tx.vaccination.findMany({
    where: { petId },
    orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
  })
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function getVaccinationCard(
  tenantId: string,
  petId: string,
): Promise<VaccinationCard> {
  return withTenant(tenantId, async (tx) => {
    await loadPet(tx, petId)
    const [rows, today] = await Promise.all([loadVaccinations(tx, petId), tenantToday(tx)])
    return buildCard(rows, today)
  })
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

export interface CreateVaccinationOptions {
  /** `record:write` — só ele registra a dose aplicada aqui. */
  canWriteClinical: boolean
}

export async function createVaccination(
  actor: ActorContext,
  petId: string,
  input: CreateVaccinationInput,
  options: CreateVaccinationOptions,
): Promise<VaccinationDto> {
  if (input.origin === 'INTERNAL' && !options.canWriteClinical) {
    throw forbidden(
      'Só o veterinário registra a vacina aplicada aqui. Registre como "Aplicada fora".',
    )
  }

  const vaccination = await withTenant(
    actor.tenantId,
    async (tx) => {
      const pet = await loadPet(tx, petId)
      const vaccineLabel = resolveLabel(input, pet.species.key)

      if (input.attendanceId) {
        const attendance = await tx.attendance.findFirst({
          where: { id: input.attendanceId, petId },
          select: { id: true },
        })
        if (!attendance) throw notFound('Atendimento não encontrado para este pet')
      }

      const today = await tenantToday(tx)
      if (input.appliedAt > today) {
        throw invalid('A data de aplicação não pode estar no futuro', [
          { field: 'appliedAt', message: 'Data no futuro' },
        ])
      }

      const vaccinationId = randomUUID()
      let batch = input.batch || null
      let batchExpiresAt = input.batchExpiresAt ?? null

      // A dose do estoque: o lote manda no que a carteira grava, como o catálogo manda no
      // nome da vacina — a carteira e o rastreio do lote não podem discordar do código.
      if (input.origin === 'INTERNAL' && input.lotId) {
        const tutor = await tx.petTutor.findFirst({
          where: { petId, role: 'PRIMARY', unlinkedAt: null },
          select: { tutorId: true },
        })
        const stock = await getVaccinationInventoryPort().consume(tx, actor, {
          vaccinationId,
          lotId: input.lotId,
          petId,
          tutorId: tutor?.tutorId ?? null,
          appliedAt: input.appliedAt,
          attendanceId: input.attendanceId ?? null,
        })
        if (stock) {
          batch = stock.batchCode
          batchExpiresAt = stock.expiresAt ?? batchExpiresAt
        }
      }

      let clinical: { appliedBy: string; vetName: string; crmv: string } | null = null
      if (input.origin === 'INTERNAL') {
        // AC-02: o lote que já tinha vencido no dia da aplicação.
        if (batchExpiresAt && batchExpiresAt < input.appliedAt) {
          throw invalid('O lote informado está vencido na data de aplicação', [
            { field: 'batchExpiresAt', message: 'Lote vencido na data de aplicação' },
          ])
        }
        clinical = await loadVaccinator(tx, actor)
      }

      const created = await tx.vaccination.create({
        data: {
          id: vaccinationId,
          tenantId: actor.tenantId,
          petId,
          attendanceId: input.attendanceId ?? null,
          origin: input.origin,
          vaccineKey: input.vaccineKey,
          vaccineLabel,
          appliedAt: new Date(input.appliedAt),
          nextDoseAt: input.nextDoseAt ? new Date(input.nextDoseAt) : null,
          manufacturer: input.manufacturer || null,
          batch,
          batchExpiresAt: batchExpiresAt ? new Date(batchExpiresAt) : null,
          appliedBy: clinical?.appliedBy ?? null,
          vetName: clinical?.vetName ?? null,
          crmv: clinical?.crmv ?? null,
          externalClinic: input.origin === 'EXTERNAL' ? input.externalClinic || null : null,
          createdBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'vaccination.created',
        entity: 'pet',
        entityId: petId,
        after: {
          vaccinationId: created.id,
          origin: created.origin,
          vaccine: created.vaccineLabel,
          appliedAt: input.appliedAt,
          nextDoseAt: input.nextDoseAt ?? null,
          stockLotId: input.origin === 'INTERNAL' ? (input.lotId ?? null) : null,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toVaccination(created)
    },
    tenantOptions(actor),
  )

  await invalidateSummary(actor.tenantId, petId)
  await publishEvent(RECORD_ROUTING_KEYS.vacinaAplicada, {
    tenantId: actor.tenantId,
    vaccinationId: vaccination.id,
    petId,
    origin: vaccination.origin,
    vaccineType: vaccination.vaccineLabel,
    nextDoseAt: vaccination.nextDoseAt,
  })
  return vaccination
}

export async function voidVaccination(
  actor: ActorContext,
  petId: string,
  vaccinationId: string,
  input: VoidVaccinationInput,
  options: CreateVaccinationOptions,
): Promise<VaccinationDto> {
  const vaccination = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.vaccination.findFirst({ where: { id: vaccinationId, petId } })
      if (!before) throw notFound('Vacina não encontrada')
      if (before.voidedAt) throw invalid('Esta vacina já foi anulada')
      // A recepção desfaz o que ela mesma transcreve; a dose assinada por um
      // veterinário só um perfil clínico desfaz.
      if (before.origin === 'INTERNAL' && !options.canWriteClinical) {
        throw forbidden('Só o veterinário anula uma vacina aplicada aqui')
      }

      const updated = await tx.vaccination.update({
        where: { id: vaccinationId },
        data: {
          voidedAt: new Date(),
          voidedBy: actor.actorUserId ?? null,
          voidReason: input.reason,
        },
      })

      // A dose que saiu do estoque volta ao lote; a que não saiu, não tem o que voltar.
      await getVaccinationInventoryPort().returnDose(
        tx,
        actor,
        vaccinationId,
        `Vacina anulada: ${input.reason}`,
      )

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'vaccination.voided',
        entity: 'pet',
        entityId: petId,
        after: { vaccinationId, vaccine: before.vaccineLabel, reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toVaccination(updated)
    },
    tenantOptions(actor),
  )

  await invalidateSummary(actor.tenantId, petId)
  return vaccination
}

// ─── Apoio ───────────────────────────────────────────────────────────────────

async function loadPet(tx: TenantTransaction, petId: string) {
  const pet = await tx.pet.findFirst({
    where: { id: petId, deletedAt: null },
    select: { id: true, species: { select: { key: true } } },
  })
  if (!pet) throw notFound('Pet não encontrado')
  return pet
}

/**
 * O nome que fica gravado. Da lista, o rótulo é o do catálogo — o que o formulário
 * mandar é ignorado, para a carteira não ter duas grafias da mesma vacina; em "Outra", o
 * nome digitado.
 */
function resolveLabel(input: CreateVaccinationInput, speciesKey: string): string {
  if (input.vaccineKey === OTHER_VACCINE_KEY) return (input.vaccineLabel ?? '').trim()

  const entry = vaccineCatalogFor(speciesKey).find((item) => item.key === input.vaccineKey)
  if (!entry) {
    throw invalid('Vacina fora da lista desta espécie. Escolha "Outra" e informe o nome.', [
      { field: 'vaccineKey', message: 'Vacina fora da lista desta espécie' },
    ])
  }
  return entry.label
}

/**
 * Quem aplicou: a ficha de profissional ligada ao usuário logado, com CRMV.
 *
 * As mesmas duas recusas do receituário, com o mesmo texto de "o que falta": a dose
 * aplicada aqui é assinada por quem está do outro lado da tela, e `record:write` sozinho
 * não distingue o veterinário do administrador que abriu a ficha dele.
 */
async function loadVaccinator(tx: TenantTransaction, actor: ActorContext) {
  if (!actor.actorUserId) {
    throw crmvRequired('A vacina aplicada aqui exige usuário identificado com registro no conselho')
  }

  const vet = await tx.professional.findFirst({
    where: { userId: actor.actorUserId, deletedAt: null, active: true },
    select: { id: true, displayName: true, crmv: true, crmvState: true },
  })
  if (!vet) {
    throw crmvRequired(
      'Seu usuário não está ligado a nenhuma ficha de profissional. Em Agenda → Profissionais, ' +
        'abra a ficha do veterinário e escolha você em "Usuário do sistema". Ou registre a ' +
        'vacina como "Aplicada fora".',
    )
  }
  if (!vet.crmv || !vet.crmvState) {
    throw crmvRequired(
      `A ficha de ${vet.displayName} não tem CRMV. Preencha o registro em Agenda → Profissionais.`,
    )
  }

  return { appliedBy: vet.id, vetName: vet.displayName, crmv: formatCrmv(vet.crmv, vet.crmvState) }
}
