import { withTenant, type TenantTransaction } from '@petshop/db'
import { loadIssuer } from '@petshop/documents'
import type { EntryCategory, StatementQuery } from '@petshop/shared-types'
import type { ActorContext } from './actor.js'
import { accountSummary } from './entries.js'
import type { StatementDocumentData } from './statement-template.js'

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

// ─── O extrato em papel (MOD-DOC-09) ─────────────────────────────────────────

/**
 * Teto de linhas da folha.
 *
 * Quinhentos lançamentos são umas quinze páginas — muito além do que alguém lê, e já
 * perto do que o Chromium leva um tempo desconfortável para paginar. Passando disso, a
 * folha diz quantas ficaram de fora e sugere um intervalo menor: entregar meio extrato
 * em silêncio seria o defeito de verdade.
 */
export const STATEMENT_PDF_MAX_LINES = 500

export interface StatementPeriod {
  from?: string | undefined
  to?: string | undefined
}

function periodLabel(period: StatementPeriod): string {
  const dia = (iso: string) => iso.split('-').reverse().join('/')

  if (period.from && period.to) return `${dia(period.from)} a ${dia(period.to)}`
  if (period.from) return `desde ${dia(period.from)}`
  if (period.to) return `até ${dia(period.to)}`
  return 'todo o histórico'
}

/**
 * Os dados da folha, montados a partir do mesmo extrato que a tela mostra.
 *
 * Não há caminho de dados próprio, e é o ponto: um PDF que somasse por conta própria
 * poderia discordar da tela que o originou — e discordar em dinheiro, com o tutor
 * segurando o papel.
 */
export async function statementDocument(
  actor: ActorContext,
  tutorId: string,
  period: StatementPeriod,
): Promise<StatementDocumentData> {
  const statement = await getStatement(actor, tutorId, {
    ...(period.from ? { from: period.from } : {}),
    ...(period.to ? { to: period.to } : {}),
    page: 1,
    limit: STATEMENT_PDF_MAX_LINES,
  })

  const { issuer, timezone, tutorName } = await withTenant(actor.tenantId, async (tx) => {
    const [emissor, tutor] = await Promise.all([
      loadIssuer(tx, actor.tenantId),
      // RN-14 reserva o nome civil a documento fiscal, e este não é um: quem tem nome
      // social é chamado por ele no próprio extrato, como no recibo.
      tx.tutor.findFirstOrThrow({
        where: { id: tutorId },
        select: { fullName: true, socialName: true },
      }),
    ])

    return {
      issuer: emissor.issuer,
      timezone: emissor.timezone,
      tutorName: tutor.socialName ?? tutor.fullName,
    }
  })

  return {
    issuer,
    timezone,
    tutorName,
    periodLabel: periodLabel(period),
    openingBalanceCents: statement.summary.openingBalanceCents,
    closingBalanceCents: statement.summary.closingBalanceCents,
    totalDebitsCents: statement.summary.totalDebitsCents,
    totalCreditsCents: statement.summary.totalCreditsCents,
    // O extrato vem do mais recente para o mais antigo, como a tela; a folha mantém a
    // mesma ordem para que quem confere uma contra a outra não precise ler ao contrário.
    lines: statement.rows.map((row) => ({
      occurredAt: row.occurred_at,
      description: row.description,
      category: row.category as EntryCategory,
      signedAmountCents: Number(row.signed_amount_cents),
      balanceAfterCents: Number(row.balance_after_cents),
      status: row.status,
    })),
    totalLines: statement.total,
    issuedAt: new Date(),
  }
}

/** O nome do arquivo, que é o que torna a pasta de downloads legível depois de três. */
export function statementFilename(period: StatementPeriod): string {
  if (period.from && period.to) return `extrato-${period.from}-a-${period.to}.pdf`
  if (period.from) return `extrato-desde-${period.from}.pdf`
  if (period.to) return `extrato-ate-${period.to}.pdf`
  return `extrato-${new Date().toISOString().slice(0, 10)}.pdf`
}
