import { Prisma, withTenant } from '@petshop/db'
import type { AssignTaxiRideInput, UpdateTaxiRideInput } from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import {
  driverUnavailable,
  invalid,
  invalidTransition,
  notFound,
  vanFull,
} from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { countOverlappingRides, effectiveCapacity, isSerializationError } from './conflicts.js'
import { openCipher } from './crypto.js'
import { checkDriverWindow, findAvailableDrivers } from './drivers.js'
import { resolveAddress } from './address.js'
import { toRideDto, type TaxiRideDto } from './mapper.js'

/**
 * Atribuição e edição da corrida (MOD-TAXI-03 e AC-06 de MOD-TAXI-04).
 *
 * A transação roda em `SERIALIZABLE` **inteira**, e não só a contagem: sob esse nível
 * o Postgres detecta que duas transações leram o mesmo conjunto de linhas e uma delas
 * o invalidou — que é exatamente a corrida por "o último lugar da van". Uma das duas
 * é abortada com 40001, e aqui isso vira 409 `ERR_TAXI_007`.
 *
 * **Reatribuir não é transição.** Trocar o motorista com o pet a bordo muda
 * `driver_id` e grava linha no log, mas o status continua `ONBOARD` (AC-06): o pet
 * está fisicamente onde estava, só mudou de mãos. Fazer disso uma transição
 * significaria retroceder o estado de um animal que já foi coletado.
 */

/** Status em que ainda faz sentido definir ou trocar o motorista. */
const ASSIGNABLE_STATUSES = ['REQUESTED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ONBOARD'] as const

export async function assignRide(
  actor: ActorContext,
  rideId: string,
  input: AssignTaxiRideInput,
): Promise<TaxiRideDto> {
  let result: { dto: TaxiRideDto; previousDriverId: string | null }

  try {
    result = await withTenant(
      actor.tenantId,
      async (tx) => {
        const ride = await tx.taxiRide.findFirst({ where: { id: rideId } })
        if (!ride) throw notFound()

        if (!(ASSIGNABLE_STATUSES as readonly string[]).includes(ride.status)) {
          throw invalidTransition(
            `Uma corrida ${ride.status === 'CANCELLED' ? 'cancelada' : 'encerrada'} não recebe motorista`,
          )
        }

        const driver = await tx.professional.findFirst({
          where: { id: input.driverId, deletedAt: null },
          select: { displayName: true, maxConcurrentPets: true, roleKey: true },
        })
        if (!driver) throw notFound('Motorista não encontrado')

        const window = await checkDriverWindow(
          tx,
          input.driverId,
          ride.windowStartsAt,
          ride.windowEndsAt,
        )
        if (!window.ok) {
          const detail =
            window.reason === 'BLOCKED'
              ? `A agenda de ${driver.displayName} está bloqueada nesta janela`
              : window.reason === 'INACTIVE'
                ? `${driver.displayName} não está mais na equipe`
                : `${driver.displayName} não trabalha nesta janela`
          throw driverUnavailable(detail, {
            reason: window.reason,
            available: await findAvailableDrivers(tx, ride.windowStartsAt, ride.windowEndsAt),
          })
        }

        let vehicleCapacity: number | null = null
        const vehicleId = input.vehicleId ?? null
        if (vehicleId) {
          const vehicle = await tx.taxiVehicle.findFirst({
            where: { id: vehicleId, deletedAt: null, active: true },
            select: { petCapacity: true },
          })
          if (!vehicle) throw notFound('Veículo não encontrado ou inativo')
          vehicleCapacity = vehicle.petCapacity
        }

        // RN-09: contagem, não existência. `excludeRideId` cobre a reatribuição —
        // ao trocar o motorista de uma corrida, ela não pode conflitar consigo mesma.
        const capacity = effectiveCapacity(driver.maxConcurrentPets, vehicleCapacity)
        const occupied = await countOverlappingRides(
          tx,
          input.driverId,
          ride.windowStartsAt,
          ride.windowEndsAt,
          ride.id,
        )
        if (occupied >= capacity) {
          throw vanFull(
            `A van de ${driver.displayName} já está com ${occupied} pet(s) nessa janela`,
            {
              capacity,
              occupied,
              available: await findAvailableDrivers(tx, ride.windowStartsAt, ride.windowEndsAt),
            },
          )
        }

        const now = new Date()
        const reassignment = ride.driverId !== null && ride.driverId !== input.driverId
        // A primeira atribuição sobe REQUESTED → ASSIGNED; a troca preserva o estado.
        const status = ride.status === 'REQUESTED' ? ('ASSIGNED' as const) : ride.status

        const updated = await tx.taxiRide.update({
          where: { id: rideId },
          data: {
            driverId: input.driverId,
            vehicleId,
            status,
            ...(ride.assignedAt === null ? { assignedAt: now } : {}),
          },
        })

        await tx.taxiRideStatusLog.create({
          data: {
            tenantId: actor.tenantId,
            rideId,
            fromStatus: ride.status,
            toStatus: status,
            occurredAt: now,
            driverId: input.driverId,
            byUserId: actor.actorUserId ?? null,
          },
        })

        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: reassignment ? 'taxi_ride.reassigned' : 'taxi_ride.assigned',
          entity: 'taxi_ride',
          entityId: rideId,
          // O motorista anterior é a primeira pergunta quando algo dá errado (§9).
          before: { driverId: ride.driverId, vehicleId: ride.vehicleId, status: ride.status },
          after: { driverId: input.driverId, vehicleId, status },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })

        const cipher = await openCipher(tx, actor.tenantId)
        return { dto: toRideDto(updated, cipher), previousDriverId: ride.driverId }
      },
      {
        ...tenantOptions(actor),
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    )
  } catch (error) {
    if (isSerializationError(error)) {
      throw vanFull('A van acabou de encher nessa janela. Escolha outro motorista.')
    }
    throw error
  }

  // AC-02 de MOD-TAXI-08: remanejo interno não avisa o tutor. Avisar a cada troca de
  // motorista ensina o cliente a silenciar o canal, e aí o aviso que importa — "o
  // motorista saiu" — também não chega.
  await publishEvent('taxi.atribuido', {
    tenantId: actor.tenantId,
    rideId,
    driverId: result.dto.driverId ?? '',
    vehicleId: result.dto.vehicleId,
    previousDriverId: result.previousDriverId,
    notify: false,
  })

  return result.dto
}

/** Janela, endereço e observação (§5, `PATCH /v1/taxi/rides/:id`). */
export async function updateRide(
  actor: ActorContext,
  rideId: string,
  input: UpdateTaxiRideInput,
): Promise<TaxiRideDto> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const ride = await tx.taxiRide.findFirst({ where: { id: rideId } })
      if (!ride) throw notFound()

      if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(ride.status)) {
        throw invalidTransition('Uma corrida encerrada não pode ser editada')
      }

      const windowStartsAt = input.windowStartsAt ?? ride.windowStartsAt
      const windowEndsAt = input.windowEndsAt ?? ride.windowEndsAt
      if (windowEndsAt <= windowStartsAt) {
        throw invalid('A janela precisa terminar depois de começar')
      }

      // Mover a janela com motorista já atribuído reabre a pergunta da capacidade:
      // ele pode não trabalhar no horário novo, ou a van já estar cheia lá.
      if (ride.driverId && (input.windowStartsAt || input.windowEndsAt)) {
        const window = await checkDriverWindow(tx, ride.driverId, windowStartsAt, windowEndsAt)
        if (!window.ok) {
          throw driverUnavailable(
            'O motorista atual não atende a nova janela. Reatribua antes de mover.',
            {
              reason: window.reason,
              available: await findAvailableDrivers(tx, windowStartsAt, windowEndsAt),
            },
          )
        }
      }

      const cipher = await openCipher(tx, actor.tenantId)
      const address = input.address
        ? await resolveAddress(tx, cipher, ride.tutorId, input.address)
        : null

      const updated = await tx.taxiRide.update({
        where: { id: rideId },
        data: {
          ...(input.windowStartsAt ? { windowStartsAt: input.windowStartsAt } : {}),
          ...(input.windowEndsAt ? { windowEndsAt: input.windowEndsAt } : {}),
          ...(address
            ? {
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
              }
            : {}),
          ...(input.notes !== undefined
            ? { notesEncrypted: input.notes === null ? null : cipher.encrypt(input.notes) }
            : {}),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'taxi_ride.updated',
        entity: 'taxi_ride',
        entityId: rideId,
        before: {
          windowStartsAt: ride.windowStartsAt.toISOString(),
          windowEndsAt: ride.windowEndsAt.toISOString(),
          zipCode: ride.zipCode,
        },
        after: {
          windowStartsAt: updated.windowStartsAt.toISOString(),
          windowEndsAt: updated.windowEndsAt.toISOString(),
          zipCode: updated.zipCode,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toRideDto(updated, cipher)
    },
    tenantOptions(actor),
  )
}
