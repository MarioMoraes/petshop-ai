import { withTenant } from '@petshop/db'
import type { InventoryAlerts } from '@petshop/shared-types'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../../shared/redis.js'
import type { ActorContext } from './actor.js'
import { expiryWindow, toProductResponse } from './mapper.js'
import { LOTS_FOR_TOTALS } from './products.js'

/**
 * MOD-ESTOQUE-09 — as contagens do sino.
 *
 * **Leitura de estado, não evento** (AC-03): não há tabela de aviso nem marca de lido. A
 * entrada que repõe o produto apaga o alerta sozinha, porque o número é recalculado.
 *
 * As contas são **as mesmas da lista**: o mesmo `toProductResponse` que a tela usa para
 * pintar os selos, sobre os mesmos produtos que o filtro mostra (ativos e não
 * excluídos). Uma consulta agregada à parte seria mais rápida e seria a segunda regra de
 * "vencendo" do módulo — e o primeiro sino a jurar "3 lotes vencendo" diante de uma lista
 * com dois.
 */
export async function getInventoryAlerts(actor: ActorContext): Promise<InventoryAlerts> {
  const key = CACHE_KEYS.inventoryAlerts(actor.tenantId)
  const cached = await cacheGet<InventoryAlerts>(key)
  if (cached) return cached

  const alerts = await withTenant(actor.tenantId, async (tx) => {
    const window = await expiryWindow(tx, actor.tenantId)
    const products = await tx.product.findMany({
      where: { deletedAt: null, active: true },
      include: LOTS_FOR_TOTALS,
    })

    let expiringLots = 0
    let lowProducts = 0
    let negativeProducts = 0
    for (const product of products) {
      const row = toProductResponse(product, window)
      expiringLots += row.expiringLots
      if (row.belowMinimum) lowProducts += 1
      if (Number(row.quantityOnHand) < 0) negativeProducts += 1
    }

    return { expiringLots, lowProducts, negativeProducts, expiryWarningDays: window.days }
  })

  await cacheSet(key, alerts, CACHE_TTL_SECONDS.inventoryAlerts)
  return alerts
}
