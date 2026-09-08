import { Prisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  TAXI_SILENT_CANCEL_REASONS,
  type CreateTaxiRidesInput,
  type TaxiLeg,
  type TaxiLegInput,
  type TaxiSettings,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import {
  duplicateLeg,
  driverUnavailable,
  invalid,
  noTaxiService,
  notFound,
  vanFull,
} from './errors.js'
import { publishEvent } from '../../shared/events.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { resolveAddress } from './address.js'
import { countOverlappingRides, effectiveCapacity, isSerializationError } from './conflicts.js'
import { openCipher } from './crypto.js'
import { checkDriverWindow, findAvailableDrivers } from './drivers.js'
import { toRideDto, type TaxiRideDto } from './mapper.js'
import { resolvePrice } from './pricing.js'
import { assertEnabled } from './settings.js'

/**
 * Criação da corrida (MOD-TAXI-01, 02, 05 e 06).
 *
 * O ponto não óbvio deste arquivo é a **cobrança**: a corrida não emite evento de
 * dinheiro nenhum. Ela grava um `appointment_items` no agendamento que serve, com
 * `duration_min = 0`, e soma o valor em `appointments.total_cents`. Quando o
 * check-out publicar `atendimento.concluido`, o MOD-LEDGER vai debitar o total — que
 * já inclui o taxi. Nenhuma linha nova de código de dinheiro (RN-05).
 *
 * O `duration_min = 0` é o detalhe que faz isso funcionar sem estragar a agenda: o
 * tempo da corrida é do motorista, não do banhista, e `ends_at` do agendamento nunca
 * é recalculado depois da criação. Somar duração aqui bloquearia a bancada por engano
 * (RN-06).
 */

/** Status do agendamento que ainda aceitam pendurar uma corrida. */
const CHARGEABLE_APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
] as const

interface AppointmentContext {
  id: string
  petId: string
  tutorId: string
  startsAt: Date
  endsAt: Date
  totalCents: bigint
}

async function loadAppointment(
  tx: TenantTransaction,
  appointmentId: string,
): Promise<AppointmentContext> {
  const appointment = await tx.appointment.findFirst({
    where: { id: appointmentId },
    select: {
      id: true,
      petId: true,
      tutorId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      totalCents: true,
    },
  })
  if (!appointment) throw notFound('Agendamento não encontrado')

  // Concluído fica de fora junto com os cancelados: o débito já foi para o ledger, e
  // um item acrescentado depois nunca seria cobrado. Perder receita em silêncio é
  // pior que recusar aqui.
  if (!(CHARGEABLE_APPOINTMENT_STATUSES as readonly string[]).includes(appointment.status)) {
    throw invalid(
      `Não é possível adicionar Taxi Dog a um agendamento ${appointment.status.toLowerCase()}`,
    )
  }

  return {
    id: appointment.id,
    petId: appointment.petId,
    tutorId: appointment.tutorId,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    totalCents: appointment.totalCents,
  }
}

/**
 * AC-03: a janela precisa fazer sentido em relação ao atendimento.
 *
 * A coleta termina antes de o serviço começar; a entrega começa depois de ele
 * terminar. Sem essa checagem, a recepção prometeria buscar o pet meia hora depois de
 * o banho já ter começado — e o erro só apareceria com o tutor esperando na porta.
 */
function assertCoherentWindow(leg: TaxiLegInput, appointment: AppointmentContext): void {
  if (leg.leg === 'PICKUP' && leg.windowEndsAt > appointment.startsAt) {
    throw invalid('A coleta precisa terminar antes do início do atendimento', [
      { field: 'windowEndsAt', message: 'Janela de coleta depois do início do atendimento' },
    ])
  }
  if (leg.leg === 'DROPOFF' && leg.windowStartsAt < appointment.endsAt) {
    throw invalid('A entrega só pode começar depois do fim do atendimento', [
      { field: 'windowStartsAt', message: 'Janela de entrega antes do fim do atendimento' },
    ])
  }
}

/** AC-04: uma perna **viva** por agendamento; cancelada e frustrada não contam. */
async function assertNoLiveLeg(
  tx: TenantTransaction,
  appointmentId: string,
  leg: TaxiLeg,
): Promise<void> {
  const existing = await tx.taxiRide.findFirst({
    where: {
      appointmentId,
      leg,
      status: { notIn: ['CANCELLED', 'FAILED'] },
    },
    select: { id: true, status: true },
  })
  if (existing) {
    throw duplicateLeg(
      leg === 'PICKUP'
        ? 'Este agendamento já tem uma corrida de ida'
        : 'Este agendamento já tem uma corrida de volta',
      { existingRide: { id: existing.id, status: existing.status } },
    )
  }
}

/** AC-02 e AC-03 de MOD-TAXI-03, quando o motorista já vem na criação. */
async function assertDriverFits(
  tx: TenantTransaction,
  leg: TaxiLegInput,
  driverId: string,
  vehicleId: string | null,
): Promise<void> {
  const driver = await tx.professional.findFirst({
    where: { id: driverId, deletedAt: null },
    select: { displayName: true, maxConcurrentPets: true },
  })
  if (!driver) throw notFound('Motorista não encontrado')

  const window = await checkDriverWindow(tx, driverId, leg.windowStartsAt, leg.windowEndsAt)
  if (!window.ok) {
    const detail =
      window.reason === 'BLOCKED'
        ? `A agenda de ${driver.displayName} está bloqueada nesta janela`
        : window.reason === 'INACTIVE'
          ? `${driver.displayName} não está mais na equipe`
          : `${driver.displayName} não trabalha nesta janela`
    throw driverUnavailable(detail, {
      reason: window.reason,
      available: await findAvailableDrivers(tx, leg.windowStartsAt, leg.windowEndsAt),
    })
  }

  let vehicleCapacity: number | null = null
  if (vehicleId) {
    const vehicle = await tx.taxiVehicle.findFirst({
      where: { id: vehicleId, deletedAt: null, active: true },
      select: { petCapacity: true },
    })
    if (!vehicle) throw notFound('Veículo não encontrado ou inativo')
    vehicleCapacity = vehicle.petCapacity
  }

  const capacity = effectiveCapacity(driver.maxConcurrentPets, vehicleCapacity)
  const occupied = await countOverlappingRides(
    tx,
    driverId,
    leg.windowStartsAt,
    leg.windowEndsAt,
  )
  if (occupied >= capacity) {
    throw vanFull(
      `A van de ${driver.displayName} já está com ${occupied} pet(s) nessa janela`,
      {
        capacity,
        occupied,
        available: await findAvailableDrivers(tx, leg.windowStartsAt, leg.windowEndsAt),
      },
    )
  }
}

/**
 * O item que cobra a corrida (RN-05).
 *
 * `label` congela o nome do serviço junto, como todo `appointment_items`: o serviço
 * pode ser renomeado depois, e o histórico precisa continuar sabendo o que foi
 * vendido.
 */
async function chargeToAppointment(
  tx: TenantTransaction,
  tenantId: string,
  appointmentId: string,
  settings: TaxiSettings,
  leg: TaxiLeg,
  priceCents: number,
): Promise<string> {
  if (!settings.taxiServiceId) throw noTaxiService()

  const service = await tx.service.findFirst({
    where: { id: settings.taxiServiceId, deletedAt: null },
    select: { id: true, name: true },
  })
  if (!service) throw noTaxiService()

  const item = await tx.appointmentItem.create({
    data: {
      tenantId,
      appointmentId,
      serviceId: service.id,
      label: `${service.name} — ${leg === 'PICKUP' ? 'ida' : 'volta'}`,
      priceCents: BigInt(priceCents),
      // RN-06: o tempo é do motorista. Zero aqui é o que impede a corrida de esticar
      // a janela do banhista.
      durationMin: 0,
    },
    select: { id: true },
  })

  await tx.appointment.update({
    where: { id: appointmentId },
    data: { totalCents: { increment: BigInt(priceCents) } },
  })

  return item.id
}

export async function createRides(
  actor: ActorContext,
  input: CreateTaxiRidesInput,
  capabilities: { canOverridePrice: boolean } = { canOverridePrice: false },
): Promise<TaxiRideDto[]> {
  // Preço manual é de quem responde pelo preço (§9), não de quem atende o balcão.
  for (const leg of input.legs) {
    if (leg.priceCentsOverride !== undefined && !capabilities.canOverridePrice) {
      throw invalid('Definir o preço da corrida à mão exige permissão de configuração')
    }
  }

  const needsSerializable = input.legs.some((leg) => leg.driverId)

  let created: TaxiRideDto[]
  try {
    created = await withTenant(
      actor.tenantId,
      async (tx) => {
        const settings = await assertEnabled(tx, actor.tenantId)
        const appointment = await loadAppointment(tx, input.appointmentId)
        const cipher = await openCipher(tx, actor.tenantId)

        const rides: TaxiRideDto[] = []
        for (const leg of input.legs) {
          assertCoherentWindow(leg, appointment)
          await assertNoLiveLeg(tx, appointment.id, leg.leg)

          const address = await resolveAddress(tx, cipher, appointment.tutorId, leg.address)
          const price = await resolvePrice(
            tx,
            settings,
            address.zipCode,
            leg.priceCentsOverride,
          )

          const vehicleId = leg.vehicleId ?? null
          if (leg.driverId) {
            await assertDriverFits(tx, leg, leg.driverId, vehicleId)
          }

          const itemId = await chargeToAppointment(
            tx,
            actor.tenantId,
            appointment.id,
            settings,
            leg.leg,
            price.priceCents,
          )

          const now = new Date()
          const row = await tx.taxiRide.create({
            data: {
              tenantId: actor.tenantId,
              appointmentId: appointment.id,
              petId: appointment.petId,
              tutorId: appointment.tutorId,
              leg: leg.leg,
              status: leg.driverId ? 'ASSIGNED' : 'REQUESTED',
              windowStartsAt: leg.windowStartsAt,
              windowEndsAt: leg.windowEndsAt,
              driverId: leg.driverId ?? null,
              vehicleId,
              addressId: address.addressId,
              zipCode: address.zipCode,
              streetEncrypted: address.streetEncrypted,
              numberEncrypted: address.numberEncrypted,
              complementEncrypted: address.complementEncrypted,
              accessNotesEncrypted: address.accessNotesEncrypted,
              district: address.district,
              city: address.city,
              state: address.state,
              latitude: address.latitude,
              longitude: address.longitude,
              zoneId: price.zoneId,
              priceCents: BigInt(price.priceCents),
              priceSource: price.source,
              appointmentItemId: itemId,
              ...(leg.driverId ? { assignedAt: now } : {}),
              ...(leg.notes ? { notesEncrypted: cipher.encrypt(leg.notes) } : {}),
              createdBy: actor.actorUserId ?? null,
            },
          })

          await tx.taxiRideStatusLog.create({
            data: {
              tenantId: actor.tenantId,
              rideId: row.id,
              fromStatus: null,
              toStatus: row.status,
              occurredAt: now,
              driverId: row.driverId,
              byUserId: actor.actorUserId ?? null,
            },
          })

          await recordAudit(tx, {
            tenantId: actor.tenantId,
            actorUserId: actor.actorUserId ?? null,
            action: 'taxi_ride.created',
            entity: 'taxi_ride',
            entityId: row.id,
            after: {
              appointmentId: appointment.id,
              leg: leg.leg,
              windowStartsAt: leg.windowStartsAt.toISOString(),
              windowEndsAt: leg.windowEndsAt.toISOString(),
              priceCents: price.priceCents,
              priceSource: price.source,
              zone: price.zoneName,
              driverId: row.driverId,
            },
            ipAddress: actor.ipAddress ?? null,
            userAgent: actor.userAgent ?? null,
          })

          // §9: preço definido à mão tem trilha própria — a justificativa é o que
          // responde "por que esta corrida custou diferente" meses depois.
          if (price.source === 'MANUAL') {
            await recordAudit(tx, {
              tenantId: actor.tenantId,
              actorUserId: actor.actorUserId ?? null,
              action: 'taxi_ride.price_overridden',
              entity: 'taxi_ride',
              entityId: row.id,
              after: {
                priceCents: price.priceCents,
                reason: leg.priceOverrideReason ?? null,
              },
              ipAddress: actor.ipAddress ?? null,
              userAgent: actor.userAgent ?? null,
            })
          }

          rides.push(toRideDto(row, cipher))
        }

        return rides
      },
      {
        ...tenantOptions(actor),
        ...(needsSerializable
          ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          : {}),
      },
    )
  } catch (error) {
    if (isSerializationError(error)) {
      // O banco decidiu a corrida. Não é erro de servidor: é o último lugar da van
      // tendo sido levado por outro atendente entre a contagem e a escrita.
      throw vanFull('A van acabou de encher nessa janela. Escolha outro motorista.')
    }
    throw error
  }

  // Pós-commit e best-effort: falha de broker não desfaz a corrida.
  for (const ride of created) {
    await publishEvent('taxi.solicitado', {
      tenantId: actor.tenantId,
      rideId: ride.id,
      appointmentId: ride.appointmentId,
      petId: ride.petId,
      tutorId: ride.tutorId,
      leg: ride.leg,
      windowStartsAt: ride.windowStartsAt,
      windowEndsAt: ride.windowEndsAt,
      priceCents: ride.priceCents,
      notify: true,
    })
  }

  return created
}

/** Reexportado para os consumidores da fatia seguinte lerem a mesma lista. */
export { TAXI_SILENT_CANCEL_REASONS }
