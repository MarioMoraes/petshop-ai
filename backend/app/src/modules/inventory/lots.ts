import { Prisma, type TenantTransaction } from '@petshop/db'
import { dateOnly } from './mapper.js'

/**
 * A trava e a escolha de lote, divididas por quem tira da prateleira: a venda
 * (`sales.ts`), o uso interno e o atendimento (`consumption.ts`).
 */

export interface LockedLotRow {
  id: string
  product_id: string
  batch_code: string
  expires_at: Date | null
  quantity_on_hand: Prisma.Decimal
}

/**
 * RN-05: trava **todos** os lotes dos produtos da venda, na ordem do `id`.
 *
 * A ordem fixa é o que impede duas vendas cruzadas — ração e coleira numa, coleira e
 * ração na outra — de travarem uma o lote que a outra espera. Travar o produto inteiro,
 * e não só o lote que o FEFO escolheria, é o que torna a escolha estável: sem a trava, o
 * saldo lido para decidir poderia mudar antes da baixa.
 */
export async function lockLotsOf(
  tx: TenantTransaction,
  productIds: string[],
): Promise<LockedLotRow[]> {
  return tx.$queryRaw<LockedLotRow[]>`
    SELECT id, product_id, batch_code, expires_at, quantity_on_hand
      FROM stock_lots
     WHERE product_id = ANY(${productIds}::uuid[])
     ORDER BY id
     FOR UPDATE
  `
}

export interface Allocation {
  lotId: string
  quantity: Prisma.Decimal
}

/**
 * RN-04 — FEFO: sai o que vence primeiro; o lote sem validade vai por último, e o
 * vencido não sai (RN-14). Uma quantidade pode atravessar lotes.
 */
export function fefo(
  lots: LockedLotRow[],
  requested: Prisma.Decimal,
  today: string,
): { allocations: Allocation[]; available: Prisma.Decimal } {
  const usable = lots
    .filter((lot) => new Prisma.Decimal(lot.quantity_on_hand).greaterThan(0))
    .filter((lot) => {
      const expires = dateOnly(lot.expires_at)
      return expires === null || expires >= today
    })
    .sort((a, b) => {
      const ea = dateOnly(a.expires_at)
      const eb = dateOnly(b.expires_at)
      if (ea === eb) return a.batch_code.localeCompare(b.batch_code)
      if (ea === null) return 1
      if (eb === null) return -1
      return ea.localeCompare(eb)
    })

  const available = usable.reduce(
    (sum, lot) => sum.plus(lot.quantity_on_hand),
    new Prisma.Decimal(0),
  )
  const allocations: Allocation[] = []
  let remaining = requested
  for (const lot of usable) {
    if (remaining.lessThanOrEqualTo(0)) break
    const take = Prisma.Decimal.min(remaining, lot.quantity_on_hand)
    allocations.push({ lotId: lot.id, quantity: take })
    remaining = remaining.minus(take)
  }
  return { allocations, available }
}
