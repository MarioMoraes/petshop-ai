import { withTenant } from '@petshop/db'
import {
  INVENTORY_EXPIRY_WARNING_DAYS,
  type InventorySettings,
  type UpdateInventorySettingsInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { invalidateInventoryAlerts } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * A configuração do estoque — hoje, só a janela do alerta de validade.
 *
 * Mora em `inventory_settings`, e não em `tenant_settings`, porque é deste módulo: quem
 * escreve `tenant_settings` é o MOD-IDENT. A linha nasce no primeiro `PATCH`; até lá, a
 * leitura devolve o padrão.
 */

export async function getInventorySettings(actor: ActorContext): Promise<InventorySettings> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.inventorySettings.findFirst({ where: { tenantId: actor.tenantId } })
    return { expiryWarningDays: row?.expiryWarningDays ?? INVENTORY_EXPIRY_WARNING_DAYS }
  })
}

export async function updateInventorySettings(
  actor: ActorContext,
  input: UpdateInventorySettingsInput,
): Promise<InventorySettings> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.inventorySettings.findFirst({ where: { tenantId: actor.tenantId } })
      const row = await tx.inventorySettings.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          expiryWarningDays: input.expiryWarningDays,
          updatedBy: actor.actorUserId ?? null,
        },
        update: {
          expiryWarningDays: input.expiryWarningDays,
          updatedBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'inventory.settings_updated',
        entity: 'inventory_settings',
        entityId: actor.tenantId,
        before: { expiryWarningDays: before?.expiryWarningDays ?? INVENTORY_EXPIRY_WARNING_DAYS },
        after: { expiryWarningDays: row.expiryWarningDays },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      // A janela decide quais lotes estão "vencendo": o sino tem de recontar.
      await invalidateInventoryAlerts(actor.tenantId)
      return { expiryWarningDays: row.expiryWarningDays }
    },
    tenantOptions(actor),
  )
}
