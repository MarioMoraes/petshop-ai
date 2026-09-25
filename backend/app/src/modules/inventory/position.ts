import { Prisma, withTenant } from '@petshop/db'
import type {
  InventoryPositionReport,
  PositionLot,
  PositionProduct,
  PositionReportQuery,
} from '@petshop/shared-types'
import type { ActorContext } from './actor.js'
import { dateOnly, expiryWindow, quantityText } from './mapper.js'

/**
 * MOD-ESTOQUE-11 — a posição e a valorização do estoque.
 *
 * **O valor é saldo × custo do lote** (RN-09), e não o último custo do produto: o lote
 * comprado a R$ 30 continua valendo R$ 30 na prateleira depois que o seguinte custou R$ 34.
 * O arredondamento é meio centavo para cima, por lote, como o preço fracionado da venda.
 *
 * **Duas coisas ficam fora do total, e a folha diz quais.** O lote sem custo — a entrada
 * que ninguém precificou — não tem valor, e inventar um (o custo do produto, zero)
 * faria o total parecer exato sem ser. E o lote negativo, que é o atendimento que tirou
 * da prateleira o que nunca tinha entrado (RN-06): somá-lo como valor negativo abateria
 * o estoque bom por conta de um registro que falta. Os dois aparecem na lista e na
 * contagem do rodapé.
 *
 * Entra todo produto não excluído com lote de saldo diferente de zero, **inclusive o
 * desativado**: desativar tira dos seletores, e não da prateleira.
 */
export async function positionReport(
  actor: ActorContext,
  query: PositionReportQuery,
  now: Date = new Date(),
): Promise<InventoryPositionReport> {
  return withTenant(actor.tenantId, async (tx) => {
    const window = await expiryWindow(tx, actor.tenantId)
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
      select: { name: true },
    })

    const products = await tx.product.findMany({
      where: {
        deletedAt: null,
        ...(query.kind ? { kind: query.kind } : {}),
        lots: { some: { quantityOnHand: { not: 0 } } },
      },
      include: {
        lots: {
          where: { quantityOnHand: { not: 0 } },
          orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    })

    const totals = {
      products: 0,
      lots: 0,
      valueCents: 0,
      uncostedLots: 0,
      negativeLots: 0,
      expiredLots: 0,
    }

    const rows: PositionProduct[] = products.map((product) => {
      let quantity = new Prisma.Decimal(0)
      let valueCents = 0

      const lots: PositionLot[] = product.lots.map((lot) => {
        const onHand = new Prisma.Decimal(lot.quantityOnHand)
        const positive = onHand.greaterThan(0)
        const expiresAt = dateOnly(lot.expiresAt)
        const expired = positive && expiresAt !== null && expiresAt < window.today
        const lotValue =
          positive && lot.unitCostCents !== null
            ? onHand
                .times(lot.unitCostCents.toString())
                .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
                .toNumber()
            : null

        quantity = quantity.plus(onHand)
        valueCents += lotValue ?? 0
        totals.lots += 1
        if (!positive) totals.negativeLots += 1
        else if (lot.unitCostCents === null) totals.uncostedLots += 1
        if (expired) totals.expiredLots += 1

        return {
          lotId: lot.id,
          batchCode: lot.batchCode,
          expiresAt,
          quantityOnHand: quantityText(onHand),
          unitCostCents: lot.unitCostCents === null ? null : Number(lot.unitCostCents),
          valueCents: lotValue,
          expired,
        }
      })

      totals.products += 1
      totals.valueCents += valueCents

      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        kind: product.kind,
        unit: product.unit,
        active: product.active,
        quantityOnHand: quantityText(quantity),
        valueCents,
        lots,
      }
    })

    return {
      tenantName: tenant.name,
      timezone: window.timezone,
      asOf: window.today,
      generatedAt: now.toISOString(),
      kind: query.kind ?? null,
      products: rows,
      totals,
    }
  })
}
