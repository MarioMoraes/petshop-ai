import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  TAXI_SETTINGS_DEFAULTS,
  type TaxiSettings,
  type UpdateTaxiSettingsInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { invalidatePricing } from '../../lib/redis.js'
import { invalid, taxiDisabled } from '../../lib/errors.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * Configuração do módulo por tenant (§4).
 *
 * A linha é criada sob demanda, na primeira leitura, e não no provisionamento do
 * tenant: o Taxi Dog nasce **desligado** (RN-22), então uma linha de defaults gravada
 * para todo tenant novo seria ruído em uma tabela que a maioria nunca vai usar.
 */

function toDto(row: {
  enabled: boolean
  taxiServiceId: string | null
  defaultPriceCents: bigint
  blockOutsideZones: boolean
  chargeFailedPickup: boolean
  defaultWindowMinutes: number
  unassignedAlertHours: number
}): TaxiSettings {
  return {
    enabled: row.enabled,
    taxiServiceId: row.taxiServiceId,
    defaultPriceCents: Number(row.defaultPriceCents),
    blockOutsideZones: row.blockOutsideZones,
    chargeFailedPickup: row.chargeFailedPickup,
    defaultWindowMinutes: row.defaultWindowMinutes,
    unassignedAlertHours: row.unassignedAlertHours,
  }
}

/** Lê a configuração, materializando os defaults quando a linha ainda não existe. */
export async function readSettings(
  tx: TenantTransaction,
  tenantId: string,
): Promise<TaxiSettings> {
  const row = await tx.taxiSettings.findUnique({ where: { tenantId } })
  if (row) return toDto(row)
  return { ...TAXI_SETTINGS_DEFAULTS, taxiServiceId: null }
}

export async function getSettings(actor: ActorContext): Promise<TaxiSettings> {
  return withTenant(actor.tenantId, (tx) => readSettings(tx, actor.tenantId))
}

/**
 * Recusa a operação quando o módulo está desligado (RN-22).
 *
 * Vive aqui e não em um preHandler porque as rotas de configuração precisam
 * funcionar **com o módulo desligado** — é assim que alguém o liga.
 */
export async function assertEnabled(
  tx: TenantTransaction,
  tenantId: string,
): Promise<TaxiSettings> {
  const settings = await readSettings(tx, tenantId)
  if (!settings.enabled) throw taxiDisabled()
  return settings
}

export async function updateSettings(
  actor: ActorContext,
  input: UpdateTaxiSettingsInput,
): Promise<TaxiSettings> {
  const updated = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await readSettings(tx, actor.tenantId)

      // O serviço que ancora a cobrança precisa existir, ser do tenant e ser da
      // categoria TAXI (RN-05). Apontar para um serviço de banho faria toda corrida
      // cobrar o preço do banho, e o erro só apareceria na conta do tutor.
      if (input.taxiServiceId) {
        const service = await tx.service.findFirst({
          where: { id: input.taxiServiceId, deletedAt: null },
          select: { id: true, category: true, name: true },
        })
        if (!service) throw invalid('Serviço não encontrado')
        if (service.category !== 'TAXI') {
          throw invalid(`O serviço "${service.name}" não é da categoria Taxi Dog`)
        }
      }

      // Ligar o módulo sem o serviço de cobrança deixaria a recepção criar corridas
      // que falhariam no ERR_TAXI_010 uma a uma. Melhor recusar aqui, uma vez.
      const enabling = input.enabled ?? before.enabled
      const serviceId = input.taxiServiceId ?? before.taxiServiceId
      if (enabling && !serviceId) {
        throw invalid(
          'Escolha o serviço de catálogo que cobra a corrida antes de ligar o Taxi Dog',
        )
      }

      const data = {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.taxiServiceId !== undefined ? { taxiServiceId: input.taxiServiceId } : {}),
        ...(input.defaultPriceCents !== undefined
          ? { defaultPriceCents: BigInt(input.defaultPriceCents) }
          : {}),
        ...(input.blockOutsideZones !== undefined
          ? { blockOutsideZones: input.blockOutsideZones }
          : {}),
        ...(input.chargeFailedPickup !== undefined
          ? { chargeFailedPickup: input.chargeFailedPickup }
          : {}),
        ...(input.defaultWindowMinutes !== undefined
          ? { defaultWindowMinutes: input.defaultWindowMinutes }
          : {}),
        ...(input.unassignedAlertHours !== undefined
          ? { unassignedAlertHours: input.unassignedAlertHours }
          : {}),
      }

      const row = await tx.taxiSettings.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          ...TAXI_SETTINGS_DEFAULTS,
          defaultPriceCents: BigInt(TAXI_SETTINGS_DEFAULTS.defaultPriceCents),
          ...data,
        },
        update: data,
      })

      const after = toDto(row)
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'taxi_settings.updated',
        entity: 'taxi_settings',
        entityId: actor.tenantId,
        before,
        after,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return after
    },
    tenantOptions(actor),
  )

  await invalidatePricing(actor.tenantId)
  return updated
}
