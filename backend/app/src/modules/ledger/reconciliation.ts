import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { recordAudit } from '../../shared/audit.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { getWalkInPort } from './walk-in-port.js'

/**
 * Fechamento e consistência (MOD-LEDGER-11) — o job que prova que o módulo não mente.
 *
 * `ledger_accounts.balance_cents` é um saldo materializado: rápido de ler, e por isso
 * mesmo capaz de divergir da verdade se alguém escrever por fora de `postEntry`, se
 * uma transação quebrar no meio, ou se um bug de sinal passar despercebido. O job
 * compara a soma de `signed_amount_cents` — coluna **gerada pelo Postgres**, imune a
 * erro da aplicação — com o saldo guardado.
 *
 * `ledger_reconciliation_divergence_total`: qualquer valor acima de zero é incidente P1.
 */

interface AccountRow {
  id: string
  tenant_id: string
  tutor_id: string
  balance_cents: bigint
}

interface ReconciliationResult {
  checked: number
  ok: number
  divergent: number
  divergences: { accountId: string; tenantId: string; expected: number; actual: number }[]
}

/** Janela padrão: contas com movimentação nas últimas 24h (AC-01). */
export const RECONCILIATION_WINDOW_HOURS = 24

/**
 * Roda para cada conta com movimentação recente.
 *
 * `since = null` varre **todas** as contas — é o modo de auditoria completa, usado
 * depois de um incidente. O padrão é a janela de 24h, porque conta parada não pode ter
 * divergido desde ontem.
 *
 * Descobrir é cross-tenant (`app_maintenance`); conferir e marcar acontece dentro de
 * `withTenant`, como em todos os jobs da casa.
 */
export async function reconcileAccounts(
  now: Date = new Date(),
  windowHours: number | null = RECONCILIATION_WINDOW_HOURS,
): Promise<ReconciliationResult> {
  const since =
    windowHours === null ? null : new Date(now.getTime() - windowHours * 3_600_000)

  const rows = since
    ? await getMaintenancePrisma().$queryRaw<AccountRow[]>`
        SELECT id, tenant_id, tutor_id, balance_cents
          FROM ledger_accounts
         WHERE last_entry_at IS NOT NULL AND last_entry_at >= ${since}
         ORDER BY last_entry_at ASC
      `
    : await getMaintenancePrisma().$queryRaw<AccountRow[]>`
        SELECT id, tenant_id, tutor_id, balance_cents
          FROM ledger_accounts
         ORDER BY created_at ASC
      `

  const result: ReconciliationResult = { checked: 0, ok: 0, divergent: 0, divergences: [] }

  for (const row of rows) {
    try {
      const divergence = await reconcileOne(row)
      result.checked += 1

      if (divergence === null) {
        result.ok += 1
        recordMetric({
          metric: 'ledger_reconciliation_ok_total',
          tenantId: row.tenant_id,
          value: 1,
          unit: 'count',
        })
        continue
      }

      result.divergent += 1
      result.divergences.push(divergence)
    } catch (error) {
      // Uma conta que não pôde ser conferida não impede a conferência das outras.
      logger.error({ err: error, accountId: row.id }, 'falha ao reconciliar conta')
    }
  }

  return result
}

/**
 * AC-02 — divergência detectada.
 *
 * A conta é marcada `needs_review` e o alerta sai. O saldo **não é corrigido
 * automaticamente**: correção silenciosa esconde o bug de origem, e o próximo
 * incidente seria descoberto pelo cliente, não pelo job.
 *
 * E a conta **não trava**: novos lançamentos continuam sendo aceitos. Um bug nosso não
 * pode impedir o petshop de registrar o pagamento que o cliente está fazendo no balcão.
 */
async function reconcileOne(
  row: AccountRow,
): Promise<{ accountId: string; tenantId: string; expected: number; actual: number } | null> {
  return withTenant(row.tenant_id, async (tx) => {
    const sums = await tx.$queryRaw<{ total: bigint | null }[]>`
      SELECT COALESCE(SUM(signed_amount_cents), 0) AS total
        FROM ledger_entries
       WHERE tenant_id = ${row.tenant_id}::uuid
         AND account_id = ${row.id}::uuid
         AND status = 'POSTED'
    `
    const expected = Number(sums[0]?.total ?? 0)
    const actual = Number(row.balance_cents)

    if (expected === actual) {
      // Conta que estava marcada e voltou a bater: a marca sai. Deixá-la acesa depois
      // de resolvido treinaria o time a ignorá-la.
      await tx.ledgerAccount.updateMany({
        where: { id: row.id, needsReview: true },
        data: { needsReview: false },
      })
      return null
    }

    await tx.ledgerAccount.update({
      where: { id: row.id },
      data: { needsReview: true },
    })

    await recordAudit(tx, {
      tenantId: row.tenant_id,
      action: 'ledger.reconciliation_divergence',
      entity: 'ledger_account',
      entityId: row.id,
      before: { balanceCents: actual },
      after: { sumOfEntriesCents: expected, differenceCents: expected - actual },
    })

    recordMetric({
      metric: 'ledger_reconciliation_divergence_total',
      tenantId: row.tenant_id,
      value: 1,
      unit: 'count',
    })

    // P1: o alerta é o produto deste job. Sem ele, `needs_review` seria um booleano
    // que ninguém olha.
    logger.error(
      {
        severity: 'P1',
        accountId: row.id,
        tenantId: row.tenant_id,
        tutorId: row.tutor_id,
        expectedCents: expected,
        actualCents: actual,
        differenceCents: expected - actual,
      },
      'divergência de saldo detectada — conta marcada para revisão',
    )

    return { accountId: row.id, tenantId: row.tenant_id, expected, actual }
  })
}

interface ReceivableRow {
  bucket: string
  total: bigint
}

/**
 * `receivables_overdue_cents` — contas a receber por faixa de atraso.
 *
 * É o indicador que o dono do petshop abre primeiro. As faixas são as do §10:
 * 0–30, 30–60 e 60+ dias, contadas a partir de `occurred_at` do débito aberto.
 */
export async function receivablesByBucket(tenantId: string, now: Date = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<ReceivableRow[]>`
      SELECT CASE
               WHEN ${now}::timestamptz - occurred_at < INTERVAL '30 days' THEN '0_30d'
               WHEN ${now}::timestamptz - occurred_at < INTERVAL '60 days' THEN '30_60d'
               ELSE '60d_plus'
             END AS bucket,
             SUM(amount_cents - settled_cents) AS total
        FROM ledger_entries
       WHERE tenant_id = ${tenantId}::uuid
         AND direction = 'DEBIT'
         AND status = 'POSTED'
         AND settled_cents < amount_cents
       GROUP BY 1
    `

    const buckets = { '0_30d': 0, '30_60d': 0, '60d_plus': 0 }
    for (const row of rows) {
      buckets[row.bucket as keyof typeof buckets] = Number(row.total)
    }

    const total = buckets['0_30d'] + buckets['30_60d'] + buckets['60d_plus']
    recordMetric({
      metric: 'receivables_total_cents',
      tenantId,
      value: total,
      unit: 'cents',
    })
    recordMetric({
      metric: 'receivables_overdue_cents',
      tenantId,
      value: buckets['30_60d'] + buckets['60d_plus'],
      unit: 'cents',
    })

    return { buckets, totalCents: total }
  })
}

interface CashflowRow {
  method: string
  total: bigint
  count: bigint
}

export interface CashflowResult {
  from: string
  to: string
  totalCents: number
  paymentsCount: number
  /** Uma linha por forma de pagamento usada no período; as não usadas ficam de fora. */
  byMethod: { method: string; totalCents: number; count: number }[]
  /** MOD-CAIXA: vendas avulsas do período, já somadas em `totalCents`. */
  walkInCents: number
  walkInCount: number
}

/**
 * Entradas por período e forma de pagamento (§5).
 *
 * `payment_recorded_total` por método é a métrica que "revela a realidade do balcão"
 * (§10) — quanto ainda é dinheiro vivo. Aqui ela vira consulta, não só log.
 *
 * Conta pelo `received_at`, não pelo `created_at`: o pagamento de ontem lançado hoje
 * pertence a ontem no fluxo de caixa. E ignora o revertido, porque dinheiro estornado
 * nunca entrou.
 */
export async function cashflowByMethod(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CashflowResult> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<CashflowRow[]>`
      SELECT method::text, SUM(amount_cents) AS total, COUNT(*) AS count
        FROM payments
       WHERE tenant_id = ${tenantId}::uuid
         AND status = 'RECORDED'
         AND received_at >= ${from}
         AND received_at <= ${to}
       GROUP BY 1
       ORDER BY 2 DESC
    `

    const byMethod = rows.map((row) => ({
      method: row.method,
      totalCents: Number(row.total),
      count: Number(row.count),
    }))

    // A venda avulsa é dinheiro que entrou sem conta de tutor: soma no total, e vem à
    // parte para quem quiser separar.
    const walkIn = await getWalkInPort().between(tx, tenantId, from, to)
    const totalCents = byMethod.reduce((sum, row) => sum + row.totalCents, 0) + walkIn.totalCents

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalCents,
      paymentsCount: byMethod.reduce((sum, row) => sum + row.count, 0),
      byMethod,
      walkInCents: walkIn.totalCents,
      walkInCount: walkIn.count,
    }
  })
}
