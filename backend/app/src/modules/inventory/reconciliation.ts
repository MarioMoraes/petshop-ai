import { Prisma, getMaintenancePrisma, withTenant } from '@petshop/db'
import { recordAudit } from '../../shared/audit.js'
import { logger, recordMetric } from '../../shared/logger.js'

/**
 * MOD-ESTOQUE-12 — a reconciliação: o job que prova que o saldo não mente.
 *
 * `stock_lots.quantity_on_hand` é o saldo materializado que as telas leem, e
 * `stock_movements` é a verdade. `recordMovement` escreve os dois na mesma transação;
 * este job confere, lote a lote, que `quantity_on_hand = Σ movements.quantity`. Uma
 * divergência só nasce de escrita por fora daquela função — um `UPDATE` à mão, um script,
 * uma segunda função que "só neste caso" mexeu no saldo.
 *
 * **Não corrige sozinho** (RN-16, o mesmo desenho da RN-18 do MOD-LEDGER): corrigir em
 * silêncio apagaria a pista do bug de origem. A divergência vira linha na trilha de
 * auditoria, métrica e log P1, e quem corrige é um ajuste humano, com motivo.
 *
 * A divergência vai para `audit_logs`, e não para `security_events` como o PRD escreveu:
 * `security_events` é um catálogo fechado de tentativas de acesso (permissão negada,
 * tenant cruzado, assinatura inválida), e um saldo que não fecha não é nenhuma delas. A
 * reconciliação do razão já grava ali, e a trilha tem leitor — `GET /v1/audit-logs`.
 *
 * **Varre todos os lotes, e não uma janela de 24h** como a do razão: o catálogo de um
 * petshop tem centenas de lotes, e a conta é um `GROUP BY` só por estabelecimento. Uma
 * janela deixaria de fora justamente o lote parado que alguém editou à mão.
 */

interface DivergentLot {
  id: string
  product_id: string
  batch_code: string
  quantity_on_hand: Prisma.Decimal
  movements_total: Prisma.Decimal
}

export interface InventoryReconciliationResult {
  tenants: number
  checked: number
  divergent: number
  divergences: {
    tenantId: string
    lotId: string
    productId: string
    onHand: string
    sumOfMovements: string
  }[]
}

export async function reconcileStock(): Promise<InventoryReconciliationResult> {
  // Descobrir é cross-tenant (`app_maintenance`); conferir é dentro de `withTenant`.
  const tenants = await getMaintenancePrisma().$queryRaw<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM stock_lots
  `

  const result: InventoryReconciliationResult = {
    tenants: 0,
    checked: 0,
    divergent: 0,
    divergences: [],
  }

  for (const { tenant_id: tenantId } of tenants) {
    try {
      const { checked, divergent } = await reconcileTenant(tenantId)
      result.tenants += 1
      result.checked += checked
      result.divergent += divergent.length
      for (const lot of divergent) {
        result.divergences.push({
          tenantId,
          lotId: lot.id,
          productId: lot.product_id,
          onHand: new Prisma.Decimal(lot.quantity_on_hand).toString(),
          sumOfMovements: new Prisma.Decimal(lot.movements_total).toString(),
        })
      }
    } catch (error) {
      // Um estabelecimento que não pôde ser conferido não impede a conferência dos outros.
      logger.error({ err: error, tenantId }, 'falha ao reconciliar o estoque')
    }
  }

  return result
}

async function reconcileTenant(
  tenantId: string,
): Promise<{ checked: number; divergent: DivergentLot[] }> {
  return withTenant(tenantId, async (tx) => {
    /*
     * Uma consulta só, e não "lê o lote, depois soma": no READ COMMITTED cada comando vê
     * um retrato único do banco, e `recordMovement` grava saldo e movimento na mesma
     * transação. Um movimento que confirma no meio da varredura aparece nos dois lados
     * ou em nenhum — nunca como falsa divergência.
     */
    const counted = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*) AS total FROM stock_lots WHERE tenant_id = ${tenantId}::uuid
    `
    const divergent = await tx.$queryRaw<DivergentLot[]>`
      SELECT l.id, l.product_id, l.batch_code, l.quantity_on_hand,
             COALESCE(m.total, 0) AS movements_total
        FROM stock_lots l
        LEFT JOIN (
          SELECT lot_id, SUM(quantity) AS total
            FROM stock_movements
           WHERE tenant_id = ${tenantId}::uuid
           GROUP BY lot_id
        ) m ON m.lot_id = l.id
       WHERE l.tenant_id = ${tenantId}::uuid
         AND l.quantity_on_hand <> COALESCE(m.total, 0)
       ORDER BY l.id
    `

    for (const lot of divergent) {
      const onHand = new Prisma.Decimal(lot.quantity_on_hand)
      const sum = new Prisma.Decimal(lot.movements_total)

      await recordAudit(tx, {
        tenantId,
        action: 'inventory.reconciliation_divergence',
        entity: 'stock_lot',
        entityId: lot.id,
        before: { quantityOnHand: onHand.toString() },
        after: {
          productId: lot.product_id,
          batchCode: lot.batch_code,
          sumOfMovements: sum.toString(),
          difference: sum.minus(onHand).toString(),
        },
      })

      recordMetric({
        metric: 'inventory_reconciliation_divergence_total',
        tenantId,
        value: 1,
        unit: 'count',
      })

      // P1: o alerta é o produto deste job.
      logger.error(
        {
          severity: 'P1',
          tenantId,
          lotId: lot.id,
          productId: lot.product_id,
          quantityOnHand: onHand.toString(),
          sumOfMovements: sum.toString(),
        },
        'divergência de saldo no estoque — o lote não fecha com os movimentos',
      )
    }

    return { checked: Number(counted[0]?.total ?? 0), divergent }
  })
}
