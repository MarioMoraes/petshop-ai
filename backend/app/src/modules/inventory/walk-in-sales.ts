import type { TenantTransaction } from '@petshop/db'

/**
 * As vendas avulsas como o financeiro as lê (MOD-CAIXA).
 *
 * O relatório de contas recebidas e o "Recebido hoje" somam o dinheiro que entrou, e a
 * venda sem tutor é dinheiro que entrou sem passar por conta nenhuma. O razão pergunta
 * por aqui, pela porta `ledger/walk-in-port.ts`, e não lê `product_sales` direto.
 *
 * Entra a venda **concluída**: a estornada devolveu o dinheiro, como o pagamento
 * revertido, que o relatório também ignora.
 */

export interface WalkInDayRow {
  day: Date
  method: string
  total: bigint
  count: bigint
}

export async function walkInSalesByDay(
  tx: TenantTransaction,
  tenantId: string,
  timezone: string,
  from: string,
  to: string,
): Promise<WalkInDayRow[]> {
  return tx.$queryRaw<WalkInDayRow[]>`
    SELECT (s.created_at AT TIME ZONE ${timezone})::date AS day,
           s.payment_method::text AS method,
           SUM(s.total_cents)     AS total,
           COUNT(*)               AS count
      FROM product_sales s
     WHERE s.tenant_id = ${tenantId}::uuid
       AND s.tutor_id IS NULL
       AND s.status = 'COMPLETED'
       AND s.payment_method IS NOT NULL
       AND (s.created_at AT TIME ZONE ${timezone})::date >= ${from}::date
       AND (s.created_at AT TIME ZONE ${timezone})::date <= ${to}::date
     GROUP BY 1, 2
     ORDER BY 1 ASC, 3 DESC
  `
}

export async function walkInSalesBetween(
  tx: TenantTransaction,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<{ totalCents: number; count: number }> {
  const rows = await tx.$queryRaw<{ total: bigint | null; count: bigint }[]>`
    SELECT SUM(total_cents) AS total, COUNT(*) AS count
      FROM product_sales
     WHERE tenant_id = ${tenantId}::uuid
       AND tutor_id IS NULL
       AND status = 'COMPLETED'
       AND payment_method IS NOT NULL
       AND created_at >= ${from}
       AND created_at <= ${to}
  `
  return { totalCents: Number(rows[0]?.total ?? 0), count: Number(rows[0]?.count ?? 0) }
}
