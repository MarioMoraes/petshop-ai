import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  ACCOUNTS_RECEIVABLE_MAX_ROWS,
  DEFAULT_TIMEZONE,
  RECEIPTS_BY_DAY_MAX_DAYS,
  addDays,
  todayIn,
  zonedMidnight,
  type AccountsReceivableQuery,
  type AccountsReceivableReport,
  type AccountsReceivableRow,
  type PaymentMethod,
  type ReceiptsByDayReport,
  type ReceiptsByDayRow,
} from '@petshop/shared-types'
import { invalid } from './errors.js'
import { logger } from '../../shared/logger.js'
import { openCipher } from './crypto.js'

/**
 * Os dois relatórios do menu Cobrança.
 *
 * A diferença para `reconciliation.ts` é de propósito, não de dado: lá ficam os
 * **indicadores** — um total por faixa, um total por método —, que o painel mostra e o
 * job publica como métrica. Aqui ficam as **listas**: quem deve, e quanto entrou em cada
 * dia. São perguntas diferentes e cabem em consultas diferentes; forçar as duas na
 * mesma função daria um retorno que metade dos chamadores descarta.
 *
 * Os dois recortam o tempo **no fuso do estabelecimento**. Em São Paulo o dia começa às
 * 03:00 UTC, e um relatório de caixa montado sobre `00:00Z` joga o movimento do fim da
 * tarde para o dia seguinte — o erro que parece certo até alguém conferir o dinheiro
 * na gaveta.
 */

/** O fuso do tenant, com o padrão da casa quando ele nunca configurou. */
export async function tenantTimezone(tx: TenantTransaction, tenantId: string): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({
    where: { tenantId },
    select: { timezone: true },
  })
  return settings?.timezone ?? DEFAULT_TIMEZONE
}

interface ReceivableRow {
  tutor_id: string
  full_name: string
  social_name: string | null
  phone_encrypted: string
  oldest_due_at: Date
  open_entries: bigint
  b0_30: bigint
  b30_60: bigint
  b60_plus: bigint
  total: bigint
}

/**
 * Contas a receber, tutor a tutor (relatório 1).
 *
 * "Em aberto" é `settled_cents < amount_cents` num débito `POSTED` — a mesma definição
 * que `receivablesByBucket` usa para o painel, e não o saldo da conta. São coisas
 * diferentes: quem deve R$ 100 e tem R$ 30 de crédito não alocado aparece aqui com os
 * R$ 100 em aberto, porque é o débito que se cobra, e o crédito o próximo pagamento
 * consome sozinho (RN-07). Somar os dois esconderia a dívida atrás de uma sobra.
 *
 * O envelhecimento conta de `occurred_at` — a data do fato gerador, que pode ser
 * retroativa (RN-23) — até a data-base. É a idade da dívida, não a idade do registro.
 *
 * **O telefone vem decifrado**, e é a única razão de este relatório existir em papel:
 * cobrar é ligar. A DEK do tenant é aberta uma vez e o resto é AES local, então o custo
 * é de uma consulta, não de N.
 */
export async function accountsReceivableReport(
  tenantId: string,
  query: AccountsReceivableQuery,
  now: Date = new Date(),
): Promise<AccountsReceivableReport> {
  return withTenant(tenantId, async (tx) => {
    const timezone = await tenantTimezone(tx, tenantId)
    const asOf = query.asOf ?? todayIn(timezone, now)

    // O corte é o **fim** do dia-base, na meia-noite do estabelecimento: um débito
    // lançado hoje de manhã pertence ao relatório de hoje, e um lançado às 22h de
    // ontem não pula para amanhã porque o servidor está em UTC.
    const asOfEnd = zonedMidnight(addDays(asOf, 1), timezone)

    const rows = await tx.$queryRaw<ReceivableRow[]>`
      SELECT t.id                AS tutor_id,
             t.full_name,
             t.social_name,
             t.phone_encrypted,
             MIN(e.occurred_at)  AS oldest_due_at,
             COUNT(*)            AS open_entries,
             COALESCE(SUM(e.amount_cents - e.settled_cents)
                      FILTER (WHERE ${asOfEnd}::timestamptz - e.occurred_at < INTERVAL '30 days'), 0) AS b0_30,
             COALESCE(SUM(e.amount_cents - e.settled_cents)
                      FILTER (WHERE ${asOfEnd}::timestamptz - e.occurred_at >= INTERVAL '30 days'
                                AND ${asOfEnd}::timestamptz - e.occurred_at < INTERVAL '60 days'), 0) AS b30_60,
             COALESCE(SUM(e.amount_cents - e.settled_cents)
                      FILTER (WHERE ${asOfEnd}::timestamptz - e.occurred_at >= INTERVAL '60 days'), 0) AS b60_plus,
             SUM(e.amount_cents - e.settled_cents) AS total
        FROM ledger_entries e
        JOIN tutors t ON t.id = e.tutor_id
       WHERE e.tenant_id = ${tenantId}::uuid
         AND e.direction = 'DEBIT'
         AND e.status = 'POSTED'
         AND e.settled_cents < e.amount_cents
         AND e.occurred_at < ${asOfEnd}::timestamptz
       GROUP BY t.id, t.full_name, t.social_name, t.phone_encrypted
      HAVING ${query.minOverdueDays}::int = 0
          OR MIN(e.occurred_at) <= ${asOfEnd}::timestamptz - (${query.minOverdueDays}::int * INTERVAL '1 day')
       ORDER BY MIN(e.occurred_at) ASC
       LIMIT ${ACCOUNTS_RECEIVABLE_MAX_ROWS + 1}
    `

    const truncated = rows.length > ACCOUNTS_RECEIVABLE_MAX_ROWS
    const page = truncated ? rows.slice(0, ACCOUNTS_RECEIVABLE_MAX_ROWS) : rows

    const cipher = await openCipher(tx, tenantId)
    const tenant = await tx.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { name: true },
    })

    const mapped: AccountsReceivableRow[] = page.map((row) => ({
      tutorId: row.tutor_id,
      // RN-14: quem tem nome social é chamado por ele em tela e comunicação — e uma
      // ligação de cobrança é comunicação.
      tutorName: row.social_name ?? row.full_name,
      phone: decryptPhone(cipher, row.phone_encrypted, row.tutor_id),
      oldestDueAt: row.oldest_due_at.toISOString(),
      overdueDays: daysBetween(row.oldest_due_at, asOfEnd),
      openEntries: Number(row.open_entries),
      buckets: {
        '0_30d': Number(row.b0_30),
        '30_60d': Number(row.b30_60),
        '60d_plus': Number(row.b60_plus),
      },
      totalCents: Number(row.total),
    }))

    // Os totais somam **o que está no papel**. Um rodapé que somasse a base inteira
    // enquanto a lista foi cortada seria a pior das duas opções: números que não
    // fecham com as linhas acima deles.
    const buckets = {
      '0_30d': sum(mapped, (row) => row.buckets['0_30d']),
      '30_60d': sum(mapped, (row) => row.buckets['30_60d']),
      '60d_plus': sum(mapped, (row) => row.buckets['60d_plus']),
    }

    return {
      tenantName: tenant.name,
      generatedAt: now.toISOString(),
      timezone,
      asOf,
      minOverdueDays: query.minOverdueDays,
      buckets,
      totalCents: buckets['0_30d'] + buckets['30_60d'] + buckets['60d_plus'],
      tutorsCount: mapped.length,
      truncated,
      rows: mapped,
    }
  })
}

interface DayRow {
  day: Date
  method: string
  total: bigint
  count: bigint
}

/**
 * Contas recebidas por dia (relatório 2).
 *
 * Conta pelo `received_at`, não pelo `created_at`: o pagamento de ontem lançado hoje
 * pertence a ontem — é a mesma escolha de `cashflowByMethod`, e trocá-la aqui faria os
 * dois números do mesmo sistema discordarem. Ignora `REVERSED`, porque dinheiro
 * estornado nunca entrou.
 *
 * O agrupamento por dia acontece **no Postgres**, com `AT TIME ZONE`. Fazê-lo em
 * JavaScript exigiria trazer todos os pagamentos do período para a memória do serviço
 * só para contá-los, e o `Intl` do Node daria o mesmo resultado com mais passos.
 */
export async function receiptsByDayReport(
  tenantId: string,
  query: { from?: string; to?: string },
  now: Date = new Date(),
): Promise<ReceiptsByDayReport> {
  return withTenant(tenantId, async (tx) => {
    const timezone = await tenantTimezone(tx, tenantId)
    const today = todayIn(timezone, now)

    // Sem período, o mês corrente até hoje — o recorte de quem abre o relatório para
    // fechar o caixa. Um dia só seria pouco para um relatório *por dia*.
    const to = query.to ?? today
    const from = query.from ?? `${today.slice(0, 7)}-01`

    if (from > to) throw invalid('A data inicial não pode ser posterior à final')
    if (daysInclusive(from, to) > RECEIPTS_BY_DAY_MAX_DAYS) {
      throw invalid(`O período não pode passar de ${RECEIPTS_BY_DAY_MAX_DAYS} dias`)
    }

    const tenant = await tx.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { name: true },
    })

    const rows = await tx.$queryRaw<DayRow[]>`
      SELECT (p.received_at AT TIME ZONE ${timezone})::date AS day,
             p.method::text,
             SUM(p.amount_cents) AS total,
             COUNT(*)            AS count
        FROM payments p
       WHERE p.tenant_id = ${tenantId}::uuid
         AND p.status = 'RECORDED'
         AND (p.received_at AT TIME ZONE ${timezone})::date >= ${from}::date
         AND (p.received_at AT TIME ZONE ${timezone})::date <= ${to}::date
       GROUP BY 1, 2
       ORDER BY 1 ASC, 3 DESC
    `

    const days: ReceiptsByDayRow[] = []
    const periodTotals = new Map<PaymentMethod, { totalCents: number; count: number }>()

    for (const row of rows) {
      const date = isoDate(row.day)
      const method = row.method as PaymentMethod
      const totalCents = Number(row.total)
      const count = Number(row.count)

      let day = days.at(-1)
      if (!day || day.date !== date) {
        day = { date, totalCents: 0, count: 0, byMethod: [] }
        days.push(day)
      }
      day.totalCents += totalCents
      day.count += count
      day.byMethod.push({ method, totalCents, count })

      const running = periodTotals.get(method) ?? { totalCents: 0, count: 0 }
      periodTotals.set(method, {
        totalCents: running.totalCents + totalCents,
        count: running.count + count,
      })
    }

    const byMethod = [...periodTotals.entries()]
      .map(([method, totals]) => ({ method, ...totals }))
      .sort((a, b) => b.totalCents - a.totalCents)

    return {
      tenantName: tenant.name,
      generatedAt: now.toISOString(),
      timezone,
      from,
      to,
      totalCents: sum(days, (day) => day.totalCents),
      paymentsCount: sum(days, (day) => day.count),
      byMethod,
      days,
    }
  })
}

function sum<T>(rows: T[], of: (row: T) => number): number {
  return rows.reduce((total, row) => total + of(row), 0)
}

const DAY_MS = 86_400_000

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS))
}

function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

/**
 * `::date` volta do driver como `Date` à meia-noite UTC. Formatar com `toISOString` e
 * cortar é exato; usar `toLocaleDateString` reinterpretaria no fuso do processo e
 * voltaria um dia atrás em qualquer servidor a oeste de Greenwich.
 */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/**
 * Telefone ilegível não derruba o relatório.
 *
 * O campo é obrigatório e cifrado com a DEK do tenant; se a decifração falhar, o que
 * há é um incidente de chave — que merece log, e não uma tela de erro no lugar da lista
 * de quem está devendo.
 */
function decryptPhone(
  cipher: { decrypt: (payload: string) => string },
  payload: string,
  tutorId: string,
): string | null {
  try {
    return cipher.decrypt(payload)
  } catch (error) {
    logger.error({ err: error, tutorId }, 'falha ao decifrar telefone no relatório de cobrança')
    return null
  }
}
