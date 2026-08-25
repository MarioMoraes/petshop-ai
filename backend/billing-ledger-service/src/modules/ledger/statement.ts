import { withTenant, type TenantTransaction } from '@petshop/db'
import type { StatementQuery } from '@petshop/shared-types'
import type { ActorContext } from './actor.js'
import { accountSummary } from './entries.js'

/**
 * Extrato (MOD-LEDGER-06) — a tela mais consultada do módulo.
 *
 * Ordena por `occurred_at` decrescente, não por `posted_at`: RN-23 separa a data do
 * fato da data do registro, e o serviço de semana passada lançado hoje pertence à
 * semana passada na visão do tutor. O índice `idx_entries_account_time` existe
 * exatamente para esta consulta.
 */

interface EntryRow {
  id: string
  tutor_id: string
  pet_id: string | null
  direction: 'DEBIT' | 'CREDIT'
  amount_cents: bigint
  signed_amount_cents: bigint
  balance_after_cents: bigint
  category: string
  description: string
  internal_notes_encrypted: string | null
  source_type: string
  source_id: string | null
  occurred_at: Date
  posted_at: Date
  status: 'POSTED' | 'REVERSED'
  settled_cents: bigint
  reversed_by_entry_id: string | null
  reverses_entry_id: string | null
}

export interface StatementResult {
  rows: EntryRow[]
  total: number
  page: number
  limit: number
  summary: {
    openingBalanceCents: number
    totalDebitsCents: number
    totalCreditsCents: number
    closingBalanceCents: number
  }
  accountBalanceCents: number
}

export async function getStatement(
  actor: ActorContext,
  tutorId: string,
  query: StatementQuery,
): Promise<StatementResult> {
  return withTenant(actor.tenantId, async (tx) => {
    const summary = await accountSummary(tx, actor.tenantId, tutorId)

    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId },
      select: { id: true },
    })

    // AC-04: tutor recém-cadastrado devolve 200 com lista vazia e saldo zero. A conta
    // é criada preguiçosamente — consultar o extrato não é motivo para criá-la.
    if (!account) {
      return {
        rows: [],
        total: 0,
        page: query.page,
        limit: query.limit,
        summary: {
          openingBalanceCents: 0,
          totalDebitsCents: 0,
          totalCreditsCents: 0,
          closingBalanceCents: 0,
        },
        accountBalanceCents: 0,
      }
    }

    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : null
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : null

    const [rows, total, opening, totals] = await Promise.all([
      listEntries(tx, actor.tenantId, account.id, from, to, query),
      countEntries(tx, actor.tenantId, account.id, from, to),
      openingBalance(tx, actor.tenantId, account.id, from),
      periodTotals(tx, actor.tenantId, account.id, from, to),
    ])

    return {
      rows,
      total,
      page: query.page,
      limit: query.limit,
      summary: {
        openingBalanceCents: opening,
        totalDebitsCents: totals.debits,
        totalCreditsCents: totals.credits,
        closingBalanceCents: opening + totals.credits - totals.debits,
      },
      accountBalanceCents: summary.balanceCents,
    }
  })
}

function listEntries(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  from: Date | null,
  to: Date | null,
  query: StatementQuery,
) {
  return tx.$queryRaw<EntryRow[]>`
    SELECT id, tutor_id, pet_id, direction, amount_cents, signed_amount_cents,
           balance_after_cents, category::text, description, internal_notes_encrypted,
           source_type::text, source_id, occurred_at, posted_at, status::text,
           settled_cents, reversed_by_entry_id, reverses_entry_id
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND (${from}::timestamptz IS NULL OR occurred_at >= ${from}::timestamptz)
       AND (${to}::timestamptz   IS NULL OR occurred_at <= ${to}::timestamptz)
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
  `
}

async function countEntries(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  from: Date | null,
  to: Date | null,
): Promise<number> {
  const rows = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND (${from}::timestamptz IS NULL OR occurred_at >= ${from}::timestamptz)
       AND (${to}::timestamptz   IS NULL OR occurred_at <= ${to}::timestamptz)
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * AC-02 — o saldo de abertura sai de um **lookup**, nunca de uma soma completa.
 *
 * Pega o `balance_after_cents` do último lançamento anterior ao início do recorte.
 * Somar a tabela inteira daria o mesmo número hoje e degradaria com o volume, que é
 * justamente o que o AC proíbe.
 *
 * **Ressalva conhecida:** `balance_after_cents` é o saldo na ordem de *postagem*,
 * enquanto o extrato ordena por `occurred_at` (RN-23). Um lançamento retroativo torna
 * a coluna não-monotônica na ordem exibida, e o saldo de abertura passa a ser "o saldo
 * quando aquele lançamento foi feito", não "a soma de tudo o que aconteceu antes".
 * O PRD escolheu esta definição conscientemente; o desempate no `ORDER BY` usa
 * `posted_at` para pelo menos ser determinístico.
 */
async function openingBalance(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  from: Date | null,
): Promise<number> {
  if (!from) return 0

  const rows = await tx.$queryRaw<{ balance_after_cents: bigint }[]>`
    SELECT balance_after_cents
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND occurred_at < ${from}::timestamptz
     ORDER BY occurred_at DESC, posted_at DESC, id DESC
     LIMIT 1
  `
  return Number(rows[0]?.balance_after_cents ?? 0)
}

async function periodTotals(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  from: Date | null,
  to: Date | null,
): Promise<{ debits: number; credits: number }> {
  const rows = await tx.$queryRaw<{ debits: bigint; credits: bigint }[]>`
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'DEBIT'),  0) AS debits,
           COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'CREDIT'), 0) AS credits
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND (${from}::timestamptz IS NULL OR occurred_at >= ${from}::timestamptz)
       AND (${to}::timestamptz   IS NULL OR occurred_at <= ${to}::timestamptz)
  `
  return { debits: Number(rows[0]?.debits ?? 0), credits: Number(rows[0]?.credits ?? 0) }
}
