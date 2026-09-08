import { withTenant, type TenantTransaction } from '@petshop/db'
import type { TaxiVehicleInput, UpdateTaxiVehicleInput } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { inUse, invalid, notFound } from './errors.js'
import { cacheDelete, CACHE_KEYS } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * A frota (MOD-TAXI-03).
 *
 * `pet_capacity` existe separado de `professionals.max_concurrent_pets` porque as
 * duas coisas são diferentes: uma é quantos pets o **motorista** dá conta de
 * conduzir, a outra é quantos cabem no **veículo** daquele dia. A capacidade efetiva
 * da corrida é `min(motorista, veículo)` (RN-04).
 */

export interface TaxiVehicleDto {
  id: string
  plate: string
  label: string
  model: string | null
  petCapacity: number
  active: boolean
}

function toDto(row: {
  id: string
  plate: string
  label: string
  model: string | null
  petCapacity: number
  active: boolean
}): TaxiVehicleDto {
  return {
    id: row.id,
    plate: row.plate,
    label: row.label,
    model: row.model,
    petCapacity: row.petCapacity,
    active: row.active,
  }
}

export async function readVehicles(
  tx: TenantTransaction,
  options: { activeOnly?: boolean } = {},
): Promise<TaxiVehicleDto[]> {
  const rows = await tx.taxiVehicle.findMany({
    where: { deletedAt: null, ...(options.activeOnly ? { active: true } : {}) },
    orderBy: { label: 'asc' },
  })
  return rows.map(toDto)
}

export async function listVehicles(actor: ActorContext): Promise<TaxiVehicleDto[]> {
  return withTenant(actor.tenantId, (tx) => readVehicles(tx))
}

export async function createVehicle(
  actor: ActorContext,
  input: TaxiVehicleInput,
): Promise<TaxiVehicleDto> {
  const created = await withTenant(
    actor.tenantId,
    async (tx) => {
      // O índice único parcial já garante isso no banco; a checagem aqui existe para
      // devolver o 409 com o nome do veículo em vez de um erro de constraint.
      const existing = await tx.taxiVehicle.findFirst({
        where: { plate: input.plate, deletedAt: null },
        select: { id: true, label: true },
      })
      if (existing) {
        throw invalid(`A placa ${input.plate} já está cadastrada em "${existing.label}"`)
      }

      const row = await tx.taxiVehicle.create({
        data: {
          tenantId: actor.tenantId,
          plate: input.plate,
          label: input.label,
          ...(input.model ? { model: input.model } : {}),
          petCapacity: input.petCapacity,
          active: input.active,
        },
      })

      const dto = toDto(row)
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'taxi_vehicle.created',
        entity: 'taxi_vehicle',
        entityId: row.id,
        after: dto,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
      return dto
    },
    tenantOptions(actor),
  )

  await cacheDelete(CACHE_KEYS.vehicles(actor.tenantId))
  return created
}

export async function updateVehicle(
  actor: ActorContext,
  vehicleId: string,
  input: UpdateTaxiVehicleInput,
): Promise<TaxiVehicleDto> {
  const updated = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.taxiVehicle.findFirst({
        where: { id: vehicleId, deletedAt: null },
      })
      if (!before) throw notFound('Veículo não encontrado')

      if (input.plate && input.plate !== before.plate) {
        const clash = await tx.taxiVehicle.findFirst({
          where: { plate: input.plate, deletedAt: null, id: { not: vehicleId } },
          select: { label: true },
        })
        if (clash) {
          throw invalid(`A placa ${input.plate} já está cadastrada em "${clash.label}"`)
        }
      }

      // Desligar um veículo com corrida futura atribuída deixaria a corrida apontando
      // para uma van que não sai da garagem. A saída é reatribuir antes.
      if (input.active === false) {
        const upcoming = await tx.taxiRide.count({
          where: {
            vehicleId,
            status: { in: ['REQUESTED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ONBOARD'] },
          },
        })
        if (upcoming > 0) {
          throw inUse(
            `Este veículo tem ${upcoming} corrida(s) em aberto. Reatribua antes de desativar.`,
            { rides: upcoming },
          )
        }
      }

      const row = await tx.taxiVehicle.update({
        where: { id: vehicleId },
        data: {
          ...(input.plate !== undefined ? { plate: input.plate } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.petCapacity !== undefined ? { petCapacity: input.petCapacity } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      })

      const dto = toDto(row)
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: input.active === false ? 'taxi_vehicle.deactivated' : 'taxi_vehicle.updated',
        entity: 'taxi_vehicle',
        entityId: vehicleId,
        before: toDto(before),
        after: dto,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
      return dto
    },
    tenantOptions(actor),
  )

  await cacheDelete(CACHE_KEYS.vehicles(actor.tenantId))
  return updated
}
