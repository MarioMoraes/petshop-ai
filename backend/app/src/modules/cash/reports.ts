import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  CASH_REPORT_MAX_DAYS,
  addDays,
  todayIn,
  zonedMidnight,
  type CashMethod,
  type CashReport,
  type CashReportDay,
  type CashReportMethod,
  type CashReportQuery,
  type CashReportTutor,
  type CashMovementType,
} from '@petshop/shared-types'
import type { ActorContext } from './actor.js'
import { invalid } from './errors.js'
import { tenantTimeZone } from './sessions.js'

/**
 * Os relatórios do caixa (menu Financeiro → Relatórios do Caixa).
 *
 * Leem **só** `cash_movements`, e não `payments`: a pergunta é o que passou pela gaveta.
 * O pagamento de tutor que entrou sem caixa aberto — o caso que o MOD-CAIXA deixa
 * existir de propósito — está no relatório de recebidas por dia da Cobrança, e não aqui.
 *
 * O período recorta o `occurred_at` **no fuso do estabelecimento**, pelos limites de
 * meia-noite local convertidos para UTC: o `WHERE` fica sobre a coluna crua, e o índice
 * `(tenant_id, session_id, occurred_at)` continua servindo ao agrupamento do dia.
 */

interface MovementGroup {
  day: Date
  type: CashMovementType
  method: CashMethod
  total: bigint
  count: bigint
}

interface TutorGroup {
  tutor_id: string
  method: CashMethod
  total: bigint
  count: bigint
  last_at: Date | null
}

const WALK_IN: readonly CashMovementType[] = ['WALK_IN_SALE', 'SALE_REFUND']
const TUTOR: readonly CashMovementType[] = ['TUTOR_PAYMENT', 'PAYMENT_REVERSAL']
/** O que conta como lançamento: o estorno desconta do valor, e não vira mais uma venda. */
const COUNTED: readonly CashMovementType[] = ['WALK_IN_SALE', 'TUTOR_PAYMENT']

export async function cashReport(
  actor: ActorContext,
  query: CashReportQuery,
  now: Date = new Date(),
): Promise<CashReport> {
  return withTenant(actor.tenantId, async (tx) => {
    const timezone = await tenantTimeZone(tx, actor.tenantId)
    const today = todayIn(timezone, now)
    const to = query.to ?? today
    const from = query.from ?? `${today.slice(0, 7)}-01`

    if (from > to) throw invalid('A data inicial não pode ser posterior à final')
    if (daysInclusive(from, to) > CASH_REPORT_MAX_DAYS) {
      throw invalid(`O período não pode passar de ${CASH_REPORT_MAX_DAYS} dias`)
    }

    const start = zonedMidnight(from, timezone)
    const end = zonedMidnight(addDays(to, 1), timezone)

    const [tenant, groups, tutorGroups, sessionsCount] = await Promise.all([
      tx.tenant.findFirstOrThrow({ where: { id: actor.tenantId }, select: { name: true } }),
      tx.$queryRaw<MovementGroup[]>`
        SELECT (m.occurred_at AT TIME ZONE ${timezone})::date AS day,
               m.type::text   AS type,
               m.method::text AS method,
               SUM(m.amount_cents) AS total,
               COUNT(*)            AS count
          FROM cash_movements m
         WHERE m.tenant_id = ${actor.tenantId}::uuid
           AND m.occurred_at >= ${start}
           AND m.occurred_at <  ${end}
         GROUP BY 1, 2, 3
      `,
      // O tutor vem do pagamento: o movimento guarda só `source_id`, de propósito
      // (a anonimização do art. 18 reescreve `tutors`, e um nome copiado sobreviveria).
      tx.$queryRaw<TutorGroup[]>`
        SELECT p.tutor_id,
               m.method::text AS method,
               SUM(m.amount_cents) AS total,
               COUNT(*) FILTER (WHERE m.type = 'TUTOR_PAYMENT') AS count,
               MAX(m.occurred_at) FILTER (WHERE m.type = 'TUTOR_PAYMENT') AS last_at
          FROM cash_movements m
          JOIN payments p ON p.id = m.source_id
         WHERE m.tenant_id = ${actor.tenantId}::uuid
           AND m.source_type = 'PAYMENT'
           AND m.type IN ('TUTOR_PAYMENT', 'PAYMENT_REVERSAL')
           AND m.occurred_at >= ${start}
           AND m.occurred_at <  ${end}
         GROUP BY 1, 2
      `,
      tx.cashSession.count({ where: { openedAt: { gte: start, lt: end } } }),
    ])

    const days = new Map<string, CashReportDay>()
    const methods = new Map<CashMethod, CashReportMethod>()
    const totals = {
      walkInCents: 0,
      tutorPaymentsCents: 0,
      receivedCents: 0,
      count: 0,
      withdrawalsCents: 0,
      depositsCents: 0,
      sessionsCount,
    }

    for (const group of groups) {
      const date = isoDate(group.day)
      const total = Number(group.total)
      const count = COUNTED.includes(group.type) ? Number(group.count) : 0

      let day = days.get(date)
      if (!day) {
        day = { date, ...emptyReceipts(), withdrawalsCents: 0, depositsCents: 0 }
        days.set(date, day)
      }

      if (group.type === 'WITHDRAWAL') {
        day.withdrawalsCents -= total
        totals.withdrawalsCents -= total
        continue
      }
      if (group.type === 'DEPOSIT') {
        day.depositsCents += total
        totals.depositsCents += total
        continue
      }
      // O troco não é venda nem sai da gaveta: ele só abre o dia.
      if (!WALK_IN.includes(group.type) && !TUTOR.includes(group.type)) continue

      let method = methods.get(group.method)
      if (!method) {
        method = { method: group.method, ...emptyReceipts() }
        methods.set(group.method, method)
      }

      for (const target of [day, method, totals]) {
        if (WALK_IN.includes(group.type)) target.walkInCents += total
        else target.tutorPaymentsCents += total
        target.receivedCents += total
        target.count += count
      }
    }

    const byTutor = await tutorRows(tx, tutorGroups)

    return {
      tenantName: tenant.name,
      generatedAt: now.toISOString(),
      timezone,
      from,
      to,
      totals,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byMethod: [...methods.values()]
        .filter((row) => row.count > 0 || row.receivedCents !== 0)
        .sort((a, b) => b.receivedCents - a.receivedCents),
      byTutor,
    }
  })
}

async function tutorRows(tx: TenantTransaction, groups: TutorGroup[]): Promise<CashReportTutor[]> {
  const byTutor = new Map<
    string,
    { receivedCents: number; count: number; lastAt: Date | null; methods: Map<CashMethod, number> }
  >()
  for (const group of groups) {
    const row = byTutor.get(group.tutor_id) ?? {
      receivedCents: 0,
      count: 0,
      lastAt: null,
      methods: new Map<CashMethod, number>(),
    }
    const count = Number(group.count)
    row.receivedCents += Number(group.total)
    row.count += count
    if (count > 0) row.methods.set(group.method, (row.methods.get(group.method) ?? 0) + count)
    if (group.last_at && (!row.lastAt || group.last_at > row.lastAt)) row.lastAt = group.last_at
    byTutor.set(group.tutor_id, row)
  }
  if (byTutor.size === 0) return []

  const tutors = await tx.tutor.findMany({
    where: { id: { in: [...byTutor.keys()] } },
    select: { id: true, fullName: true },
  })
  const names = new Map(tutors.map((tutor) => [tutor.id, tutor.fullName]))

  return (
    [...byTutor.entries()]
      // Um estorno sozinho no período, sem o pagamento que ele desfaz, não tem data de
      // pagamento para mostrar — e não é o que a pergunta "quem pagou" procura.
      .filter(([, row]) => row.lastAt !== null)
      .map(([tutorId, row]) => ({
        tutorId,
        tutorName: names.get(tutorId) ?? 'Tutor removido',
        count: row.count,
        receivedCents: row.receivedCents,
        methods: [...row.methods.entries()].sort((a, b) => b[1] - a[1]).map(([method]) => method),
        lastPaymentAt: (row.lastAt as Date).toISOString(),
      }))
      .sort((a, b) => b.receivedCents - a.receivedCents || a.tutorName.localeCompare(b.tutorName))
  )
}

function emptyReceipts() {
  return { walkInCents: 0, tutorPaymentsCents: 0, receivedCents: 0, count: 0 }
}

const DAY_MS = 86_400_000

function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

/** `::date` volta do driver como `Date` à meia-noite UTC; cortar o ISO é exato. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}
