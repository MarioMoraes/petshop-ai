import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  TAXI_BACKDATE_LIMIT_MS,
  TAXI_RIDE_STATUS_LABELS,
  TAXI_SILENT_CANCEL_REASONS,
  canTransition,
  type CancelTaxiRideInput,
  type FailTaxiRideInput,
  type TaxiCancelReason,
  type TaxiRideStatus,
  type TaxiStatusTransitionInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { invalid, invalidTransition, notFound } from './errors.js'
import { publishEvent } from '../../shared/events.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { openCipher } from './crypto.js'
import { toRideDto, type TaxiRideDto, type TaxiRideRow } from './mapper.js'
import { readSettings } from './settings.js'

/**
 * A máquina de estado da corrida (§6 do PRD taxi_dog_07).
 *
 * Três regras deste arquivo não são óbvias e todas as três têm o mesmo motivo — o pet
 * é um animal vivo em um lugar físico, e o registro não pode mentir sobre onde ele
 * está:
 *
 * **`ONBOARD` não cancela** (AC-06 de MOD-TAXI-09). De `ONBOARD` só se sai por
 * `DELIVERED` ou `FAILED`. "Cancelado" com o pet dentro da van seria um registro que
 * não diz onde o animal foi parar.
 *
 * **`FAILED` só a partir de quem já saiu.** Falhar antes de `EN_ROUTE` é cancelar — e
 * são coisas diferentes na conta do tutor (RN-16) e na métrica de falha por causa.
 *
 * **A volta espera a conclusão** (RN-10). A perna `DROPOFF` só sai de `ASSIGNED`
 * depois que `ready_at` foi preenchido pelo `atendimento.concluido`. Sair antes é ir
 * buscar um pet que ainda está na secagem.
 */

const TIMESTAMP_FIELD: Partial<Record<TaxiRideStatus, keyof TaxiRideRow>> = {
  ASSIGNED: 'assignedAt',
  EN_ROUTE: 'enRouteAt',
  ARRIVED: 'arrivedAt',
  ONBOARD: 'onboardAt',
  DELIVERED: 'deliveredAt',
}

/** Os eventos que cada transição publica (§6). `notify` sai da tabela do §8. */
const TRANSITION_EVENT = {
  EN_ROUTE: 'taxi.a_caminho',
  ARRIVED: 'taxi.chegou',
  ONBOARD: 'taxi.coletado',
  DELIVERED: 'taxi.entregue',
} as const

/**
 * RN-20: a hora informada pelo motorista, validada.
 *
 * Retroação de até 6h cobre o turno de quem ficou sem sinal na rua; o futuro é
 * recusado porque não existe "cheguei daqui a pouco". `recorded_at` é sempre o
 * servidor, e as duas ficam no log — quem audita precisa ver que houve retroação.
 */
function resolveOccurredAt(input: Date | undefined, now: Date): Date {
  if (!input) return now
  if (input.getTime() > now.getTime() + 60_000) {
    throw invalid('A hora informada não pode estar no futuro', [
      { field: 'occurredAt', message: 'Hora no futuro' },
    ])
  }
  if (now.getTime() - input.getTime() > TAXI_BACKDATE_LIMIT_MS) {
    throw invalid('A hora informada está muito no passado (limite de 6 horas)', [
      { field: 'occurredAt', message: 'Retroação acima do limite' },
    ])
  }
  return input
}

interface TransitionResult {
  dto: TaxiRideDto
  from: TaxiRideStatus
  occurredAt: Date
}

/**
 * O que sai de `failRide` e `cancelRide`.
 *
 * `chargeRemoved` não é detalhe interno: a tela precisa dizer "a corrida não será
 * cobrada" ou calar sobre isso, e a diferença depende de `charge_failed_pickup` do
 * tenant (RN-16) e de o agendamento já ter sido concluído ou não.
 */
export interface ClosedRide {
  ride: TaxiRideDto
  chargeRemoved: boolean
}

/** O núcleo compartilhado por `advanceRide`, `failRide` e `cancelRide`. */
async function applyTransition(
  tx: TenantTransaction,
  actor: ActorContext,
  rideId: string,
  to: TaxiRideStatus,
  options: {
    occurredAt: Date
    notes?: string | undefined
    scopeDriverId?: string | undefined
    extraData?: Record<string, unknown>
    /** Pula a checagem de `ready_at`; a cascata de evento não a quer. */
    skipReadyGate?: boolean
  },
): Promise<TransitionResult> {
  const ride = await tx.taxiRide.findFirst({
    where: {
      id: rideId,
      ...(options.scopeDriverId ? { driverId: options.scopeDriverId } : {}),
    },
  })
  if (!ride) throw notFound()

  const from = ride.status as TaxiRideStatus
  if (!canTransition(from, to)) {
    throw invalidTransition(
      to === 'DELIVERED' && from === 'ARRIVED'
        ? 'Marque a coleta do pet antes da entrega'
        : `Uma corrida em "${TAXI_RIDE_STATUS_LABELS[from]}" não pode ir para "${TAXI_RIDE_STATUS_LABELS[to]}"`,
    )
  }

  // RN-10: a volta espera o atendimento terminar.
  if (
    !options.skipReadyGate &&
    to === 'EN_ROUTE' &&
    ride.leg === 'DROPOFF' &&
    ride.readyAt === null
  ) {
    throw invalidTransition(
      'O atendimento ainda não terminou — o pet não está pronto para voltar',
    )
  }

  const cipher = await openCipher(tx, actor.tenantId)
  const timestampField = TIMESTAMP_FIELD[to]

  const updated = await tx.taxiRide.update({
    where: { id: rideId },
    data: {
      status: to,
      ...(timestampField ? { [timestampField]: options.occurredAt } : {}),
      ...(options.extraData ?? {}),
      ...(options.notes ? { notesEncrypted: cipher.encrypt(options.notes) } : {}),
    },
  })

  await tx.taxiRideStatusLog.create({
    data: {
      tenantId: actor.tenantId,
      rideId,
      fromStatus: from,
      toStatus: to,
      occurredAt: options.occurredAt,
      driverId: ride.driverId,
      byUserId: actor.actorUserId ?? null,
      ...(options.notes ? { notesEncrypted: cipher.encrypt(options.notes) } : {}),
    },
  })

  await recordAudit(tx, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId ?? null,
    action: 'taxi_ride.status_changed',
    entity: 'taxi_ride',
    entityId: rideId,
    before: { status: from },
    after: {
      status: to,
      // §9: expor a retroação é o ponto. As duas horas juntas na trilha.
      occurredAt: options.occurredAt.toISOString(),
      recordedAt: new Date().toISOString(),
      driverId: ride.driverId,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  return { dto: toRideDto(updated, cipher), from, occurredAt: options.occurredAt }
}

/** MOD-TAXI-04: saí, cheguei, peguei o pet, entreguei. */
export async function advanceRide(
  actor: ActorContext,
  rideId: string,
  input: TaxiStatusTransitionInput,
  scopeDriverId?: string,
): Promise<TaxiRideDto> {
  if (input.to === 'FAILED' || input.to === 'CANCELLED') {
    throw invalid(
      input.to === 'FAILED'
        ? 'Use a rota de falha para registrar uma coleta frustrada'
        : 'Use a rota de cancelamento',
    )
  }

  const now = new Date()
  const occurredAt = resolveOccurredAt(input.occurredAt, now)

  const result = await withTenant(
    actor.tenantId,
    (tx) =>
      applyTransition(tx, actor, rideId, input.to, {
        occurredAt,
        notes: input.notes,
        scopeDriverId,
      }),
    tenantOptions(actor),
  )

  const routingKey = TRANSITION_EVENT[input.to as keyof typeof TRANSITION_EVENT]
  if (routingKey) {
    await publishEvent(routingKey, {
      tenantId: actor.tenantId,
      rideId,
      appointmentId: result.dto.appointmentId,
      petId: result.dto.petId,
      tutorId: result.dto.tutorId,
      leg: result.dto.leg,
      driverId: result.dto.driverId,
      occurredAt: occurredAt.toISOString(),
      // AC-02 de MOD-TAXI-08: "coletei" na perna de volta é o pet saindo do salão,
      // e o tutor não precisa de aviso para isso — ele recebe o "entreguei".
      notify: !(input.to === 'ONBOARD' && result.dto.leg === 'DROPOFF'),
    })
  }

  return result.dto
}

/**
 * MOD-TAXI-09 AC-02: ninguém em casa, endereço errado, pet que não embarcou.
 *
 * O agendamento **não** é cancelado junto (RN-13). A falta é da corrida; quem decide
 * se o tutor ainda traz o pet é a recepção, com ele na linha. Cancelar a agenda por
 * conta própria seria decidir pelo cliente.
 */
export async function failRide(
  actor: ActorContext,
  rideId: string,
  input: FailTaxiRideInput,
  scopeDriverId?: string,
): Promise<ClosedRide> {
  const now = new Date()
  const occurredAt = resolveOccurredAt(input.occurredAt, now)

  const { result, chargeRemoved } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const settings = await readSettings(tx, actor.tenantId)
      const transition = await applyTransition(tx, actor, rideId, 'FAILED', {
        occurredAt,
        notes: input.notes,
        scopeDriverId,
        extraData: { failureReason: input.reason },
      })

      // RN-16: porta fechada não se cobra por padrão. O tenant que quiser cobrar liga
      // `charge_failed_pickup`, e a política fica visível na configuração.
      const removed = settings.chargeFailedPickup
        ? false
        : await removeCharge(tx, rideId, transition.dto.appointmentId)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'taxi_ride.failed',
        entity: 'taxi_ride',
        entityId: rideId,
        after: { reason: input.reason, chargeRemoved: removed },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { result: transition, chargeRemoved: removed }
    },
    tenantOptions(actor),
  )

  await publishEvent('taxi.falhou', {
    tenantId: actor.tenantId,
    rideId,
    appointmentId: result.dto.appointmentId,
    tutorId: result.dto.tutorId,
    reason: input.reason,
    occurredAt: occurredAt.toISOString(),
    notify: true,
  })

  return { ride: result.dto, chargeRemoved }
}

/**
 * Remove o item de cobrança e devolve o valor ao total do agendamento.
 *
 * AC-03 de MOD-TAXI-05: corrida não rodada não se cobra. Só funciona porque o
 * agendamento ainda não foi concluído — depois do check-out o débito já está no
 * ledger, e desfazê-lo é estorno, não subtração.
 */
async function removeCharge(
  tx: TenantTransaction,
  rideId: string,
  appointmentId: string,
): Promise<boolean> {
  const ride = await tx.taxiRide.findFirstOrThrow({
    where: { id: rideId },
    select: { appointmentItemId: true, priceCents: true },
  })
  if (!ride.appointmentItemId) return false

  const appointment = await tx.appointment.findFirst({
    where: { id: appointmentId },
    select: { status: true },
  })
  // Concluído: o débito já saiu para o ledger. Mexer no item aqui deixaria o
  // agendamento e o lançamento discordando sobre quanto o tutor deve.
  if (!appointment || appointment.status === 'COMPLETED') return false

  await tx.appointmentItem.deleteMany({ where: { id: ride.appointmentItemId } })
  await tx.appointment.update({
    where: { id: appointmentId },
    data: { totalCents: { decrement: ride.priceCents } },
  })
  await tx.taxiRide.update({
    where: { id: rideId },
    data: { appointmentItemId: null },
  })

  return true
}

/** MOD-TAXI-09 AC-01: cancelamento, com a cobrança saindo junto. */
export async function cancelRide(
  actor: ActorContext,
  rideId: string,
  input: CancelTaxiRideInput,
): Promise<ClosedRide> {
  const now = new Date()

  const { result, chargeRemoved } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const transition = await applyTransition(tx, actor, rideId, 'CANCELLED', {
        occurredAt: now,
        notes: input.notes,
        extraData: { cancelReason: input.reason, cancelledAt: now },
      })

      const removed = await removeCharge(tx, rideId, transition.dto.appointmentId)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'taxi_ride.cancelled',
        entity: 'taxi_ride',
        entityId: rideId,
        after: { reason: input.reason, chargeRemoved: removed },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { result: transition, chargeRemoved: removed }
    },
    tenantOptions(actor),
  )

  await publishEvent('taxi.cancelado', {
    tenantId: actor.tenantId,
    rideId,
    appointmentId: result.dto.appointmentId,
    tutorId: result.dto.tutorId,
    reason: input.reason,
    chargeRemoved,
    notify: !isSilent(input.reason),
  })

  return { ride: result.dto, chargeRemoved }
}

/** AC-03 de MOD-TAXI-08: o óbito e a cascata cancelam em silêncio. */
export function isSilent(reason: TaxiCancelReason): boolean {
  return TAXI_SILENT_CANCEL_REASONS.includes(reason)
}

export { applyTransition, removeCharge, resolveOccurredAt }
