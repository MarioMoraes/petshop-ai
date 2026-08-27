import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  resolveZipZone,
  type TaxiZoneInput,
  type UpdateTaxiZoneInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { inUse, notFound, overlappingZone } from '../../lib/errors.js'
import { invalidatePricing } from '../../lib/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * Zonas de preço (MOD-TAXI-06).
 *
 * A resolução por prefixo mais longo vive em `@petshop/shared-types`
 * (`resolveZipZone`) e não aqui: a tela de zonas precisa da mesma resposta para
 * mostrar "este CEP cairia na Zona Sul" antes de salvar, e duas implementações da
 * mesma regra divergiriam no primeiro caso de borda.
 */

export interface TaxiZoneDto {
  id: string
  name: string
  zipPrefixes: string[]
  priceCents: number
  active: boolean
}

function toDto(row: {
  id: string
  name: string
  zipPrefixes: string[]
  priceCents: bigint
  active: boolean
}): TaxiZoneDto {
  return {
    id: row.id,
    name: row.name,
    zipPrefixes: row.zipPrefixes,
    priceCents: Number(row.priceCents),
    active: row.active,
  }
}

export async function readZones(
  tx: TenantTransaction,
  options: { activeOnly?: boolean } = {},
): Promise<TaxiZoneDto[]> {
  const rows = await tx.taxiZone.findMany({
    where: { deletedAt: null, ...(options.activeOnly ? { active: true } : {}) },
    orderBy: { name: 'asc' },
  })
  return rows.map(toDto)
}

export async function listZones(actor: ActorContext): Promise<TaxiZoneDto[]> {
  return withTenant(actor.tenantId, (tx) => readZones(tx))
}

/**
 * RN-17: prefixo idêntico em duas zonas é recusado.
 *
 * Prefixos que se **contêm** (`0100` e `010012`) são legítimos e convivem — o mais
 * longo vence na resolução. O que não pode existir é o empate exato, porque aí a
 * regra do mais longo não decide nada e o preço passaria a depender da ordem em que
 * as zonas foram lidas.
 */
async function assertNoExactOverlap(
  tx: TenantTransaction,
  prefixes: string[],
  excludeZoneId?: string,
): Promise<void> {
  const others = await tx.taxiZone.findMany({
    where: { deletedAt: null, ...(excludeZoneId ? { id: { not: excludeZoneId } } : {}) },
    select: { id: true, name: true, zipPrefixes: true },
  })

  for (const other of others) {
    const clash = prefixes.find((prefix) => other.zipPrefixes.includes(prefix))
    if (clash) {
      throw overlappingZone(
        `O prefixo ${clash} já pertence à zona "${other.name}"`,
        { conflictingZone: { id: other.id, name: other.name }, prefix: clash },
      )
    }
  }
}

export async function createZone(
  actor: ActorContext,
  input: TaxiZoneInput,
): Promise<TaxiZoneDto> {
  const created = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertNoExactOverlap(tx, input.zipPrefixes)

      const row = await tx.taxiZone.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          zipPrefixes: input.zipPrefixes,
          priceCents: BigInt(input.priceCents),
          active: input.active,
        },
      })

      const dto = toDto(row)
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'taxi_zone.created',
        entity: 'taxi_zone',
        entityId: row.id,
        after: dto,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
      return dto
    },
    tenantOptions(actor),
  )

  await invalidatePricing(actor.tenantId)
  return created
}

export async function updateZone(
  actor: ActorContext,
  zoneId: string,
  input: UpdateTaxiZoneInput,
): Promise<TaxiZoneDto> {
  const updated = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.taxiZone.findFirst({ where: { id: zoneId, deletedAt: null } })
      if (!before) throw notFound('Zona não encontrada')

      if (input.zipPrefixes) await assertNoExactOverlap(tx, input.zipPrefixes, zoneId)

      const row = await tx.taxiZone.update({
        where: { id: zoneId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.zipPrefixes !== undefined ? { zipPrefixes: input.zipPrefixes } : {}),
          ...(input.priceCents !== undefined ? { priceCents: BigInt(input.priceCents) } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      })

      const dto = toDto(row)
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: input.active === false ? 'taxi_zone.deactivated' : 'taxi_zone.updated',
        entity: 'taxi_zone',
        entityId: zoneId,
        before: toDto(before),
        after: dto,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
      return dto
    },
    tenantOptions(actor),
  )

  await invalidatePricing(actor.tenantId)
  return updated
}

/**
 * Exclusão só quando ninguém depende (§5).
 *
 * Zona com corrida futura vira `ERR_TAXI_013` e a saída é desativar: o preço da
 * corrida já está congelado nela (RN-07), e apagar a linha faria o histórico perder
 * a resposta para "por que esta corrida custou R$ 30?".
 */
export async function deleteZone(actor: ActorContext, zoneId: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const zone = await tx.taxiZone.findFirst({ where: { id: zoneId, deletedAt: null } })
      if (!zone) throw notFound('Zona não encontrada')

      const rides = await tx.taxiRide.count({ where: { zoneId } })
      if (rides > 0) {
        throw inUse(
          `Esta zona é usada por ${rides} corrida(s). Desative-a em vez de excluir.`,
          { rides },
        )
      }

      await tx.taxiZone.update({ where: { id: zoneId }, data: { deletedAt: new Date() } })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'taxi_zone.deleted',
        entity: 'taxi_zone',
        entityId: zoneId,
        before: toDto(zone),
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await invalidatePricing(actor.tenantId)
}

/** Reexportado para o `pricing.ts` e para os testes lerem a mesma regra. */
export { resolveZipZone }
