import { Prisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  CASH_METHODS,
  CASH_MOVEMENT_LABELS,
  DEFAULT_TIMEZONE,
  formatBRL,
  todayIn,
  type CashAdjustmentInput,
  type CashAlerts,
  type CashMethod,
  type CashMethodTotal,
  type CashMovementResponse,
  type CashMovementType,
  type CashSessionDetail,
  type CashSessionListQuery,
  type CashSessionPage,
  type CashSessionSummary,
  type CloseCashSessionInput,
  type CurrentCashSession,
  type OpenCashSessionInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { recordMetric } from '../../shared/logger.js'
import { tenantOptions, type ActorContext } from './actor.js'
import {
  alreadyClosed,
  alreadyOpen,
  differenceWithoutNotes,
  invalid,
  noOpenSession,
  notFound,
  withdrawalAboveCash,
} from './errors.js'
import { lockOpenSession, lockSessionIfOpen, postCashMovement } from './register.js'

/**
 * MOD-CAIXA — a sessão de caixa: abrir, sangrar, suprir, fechar e ler.
 *
 * **O esperado é sempre a soma dos movimentos**, e nunca uma coluna que se atualiza:
 * `cash_movements` é append-only por trigger, e a sessão só guarda o que é dela — quem
 * abriu, o troco, e no fechamento a contagem congelada. Uma coluna de saldo seria a
 * segunda verdade, e a primeira a divergir (a lição do MOD-ESTOQUE, que precisou de uma
 * reconciliação para vigiar a sua).
 */

/** O que é venda, e não movimento de gaveta: troco, sangria e suprimento ficam de fora. */
const RECEIPT_TYPES: readonly CashMovementType[] = [
  'WALK_IN_SALE',
  'SALE_REFUND',
  'TUTOR_PAYMENT',
  'PAYMENT_REVERSAL',
]

interface StoredCount {
  method: CashMethod
  expectedCents: number
  countedCents: number | null
}

type SessionRow = Prisma.CashSessionGetPayload<object>

interface GroupRow {
  sessionId: string
  method: string
  type: string
  total: number
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

export async function openSession(
  actor: ActorContext,
  input: OpenCashSessionInput,
): Promise<CashSessionDetail> {
  try {
    return await withTenant(
      actor.tenantId,
      async (tx) => {
        const session = await tx.cashSession.create({
          data: {
            tenantId: actor.tenantId,
            openedBy: actor.actorUserId ?? null,
            openingFloatCents: BigInt(input.openingFloatCents),
          },
        })

        // O troco também é movimento: é o que faz o esperado em dinheiro começar do
        // valor que estava na gaveta, sem uma regra especial no fechamento.
        if (input.openingFloatCents > 0) {
          await postCashMovement(tx, actor, {
            sessionId: session.id,
            type: 'OPENING_FLOAT',
            method: 'CASH',
            amountCents: input.openingFloatCents,
          })
        }

        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'cash.opened',
          entity: 'cash_session',
          entityId: session.id,
          after: { openingFloatCents: input.openingFloatCents },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })

        return detail(tx, session.id)
      },
      tenantOptions(actor),
    )
  } catch (error) {
    // Dois cliques em "Abrir caixa": o índice parcial de um aberto por estabelecimento
    // recusa o segundo. Num índice parcial o Prisma devolve `meta.target: null`, e por
    // isso a colisão é reconhecida pelo modelo.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      (error.meta as { modelName?: string } | undefined)?.modelName === 'CashSession'
    ) {
      throw alreadyOpen()
    }
    throw error
  }
}

/** Sangria e suprimento: dinheiro que sai da gaveta para o cofre, ou entra para dar troco. */
export async function adjustSession(
  actor: ActorContext,
  input: CashAdjustmentInput,
): Promise<CashSessionDetail> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const session = await lockOpenSession(tx)
      if (!session) throw noOpenSession()

      if (input.type === 'WITHDRAWAL') {
        const cash = await expectedCash(tx, session.id)
        if (input.amountCents > cash) throw withdrawalAboveCash(formatBRL(Math.max(0, cash)))
      }

      await postCashMovement(tx, actor, {
        sessionId: session.id,
        type: input.type,
        method: 'CASH',
        amountCents: input.type === 'WITHDRAWAL' ? -input.amountCents : input.amountCents,
        reason: input.reason,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: input.type === 'WITHDRAWAL' ? 'cash.withdrawal' : 'cash.deposit',
        entity: 'cash_session',
        entityId: session.id,
        after: { amountCents: input.amountCents, reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return detail(tx, session.id)
    },
    tenantOptions(actor),
  )
}

/**
 * O fechamento: a contagem contra o esperado, congelada na sessão.
 *
 * O dinheiro é a única contagem obrigatória — é o que está na gaveta, e é onde a
 * diferença aparece. PIX e cartão são conferidos contra o extrato e a maquininha quando
 * o operador quiser: a forma não informada fica sem contagem, e **não entra na
 * diferença**, em vez de ser dada como conferida.
 *
 * Diferença diferente de zero exige justificativa: fechar com R$ 20 faltando e sem uma
 * palavra é o caso que o fechamento existe para impedir.
 */
export async function closeSession(
  actor: ActorContext,
  sessionId: string,
  input: CloseCashSessionInput,
): Promise<CashSessionDetail> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const session = await lockSessionIfOpen(tx, sessionId)
      if (!session) {
        const exists = await tx.cashSession.findFirst({
          where: { id: sessionId },
          select: { id: true },
        })
        throw exists ? alreadyClosed() : notFound()
      }

      const counted = new Map<CashMethod, number>()
      for (const count of input.counts) {
        if (counted.has(count.method)) {
          throw invalid('Cada forma de pagamento aparece uma vez na contagem')
        }
        counted.set(count.method, count.countedCents)
      }
      if (!counted.has('CASH')) {
        throw invalid('Conte o dinheiro da gaveta antes de fechar', [
          { field: 'counts', message: 'Informe o dinheiro contado' },
        ])
      }

      const expected = await expectedByMethod(tx, sessionId)
      const methods = CASH_METHODS.filter(
        (method) => method === 'CASH' || expected.has(method) || counted.has(method),
      )
      const counts: StoredCount[] = methods.map((method) => ({
        method,
        expectedCents: expected.get(method) ?? 0,
        countedCents: counted.get(method) ?? null,
      }))
      const differenceCents = counts.reduce(
        (sum, row) =>
          row.countedCents === null ? sum : sum + row.countedCents - row.expectedCents,
        0,
      )

      const notes = input.notes?.trim() || null
      if (differenceCents !== 0 && !notes) {
        throw differenceWithoutNotes(signedBRL(differenceCents))
      }

      await tx.cashSession.update({
        where: { id: sessionId },
        data: {
          status: 'CLOSED',
          closedBy: actor.actorUserId ?? null,
          closedAt: new Date(),
          closingCounts: counts as unknown as Prisma.InputJsonValue,
          differenceCents: BigInt(differenceCents),
          closingNotes: notes,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'cash.closed',
        entity: 'cash_session',
        entityId: sessionId,
        after: { counts, differenceCents, notes },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      if (differenceCents !== 0) {
        recordMetric({
          metric: 'cash_closing_difference_cents',
          tenantId: actor.tenantId,
          value: differenceCents,
          unit: 'cents',
        })
      }

      return detail(tx, sessionId)
    },
    tenantOptions(actor),
  )
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function currentSession(actor: ActorContext): Promise<CurrentCashSession> {
  return withTenant(actor.tenantId, async (tx) => {
    const open = await tx.cashSession.findFirst({
      where: { status: 'OPEN' },
      select: { id: true },
    })
    return { session: open ? await detail(tx, open.id) : null }
  })
}

export async function getSession(actor: ActorContext, id: string): Promise<CashSessionDetail> {
  return withTenant(actor.tenantId, (tx) => detail(tx, id))
}

/**
 * O caixa esquecido aberto, para o sino.
 *
 * Esquecido é o que foi aberto num dia que já passou, no fuso do estabelecimento — e não
 * "aberto há mais de N horas": o petshop que abre às 7h e fecha às 21h tem catorze horas
 * de caixa legítimo, e o que abriu às 22h para uma venda tardia não está esquecido às
 * 23h. Um caixa só por estabelecimento faz desse esquecimento um bloqueio real: a venda
 * de hoje cai no fechamento de ontem.
 */
export async function cashAlerts(actor: ActorContext, now: Date = new Date()): Promise<CashAlerts> {
  return withTenant(actor.tenantId, async (tx) => {
    const open = await tx.cashSession.findFirst({
      where: { status: 'OPEN' },
      select: { id: true, openedAt: true },
    })
    if (!open) return { staleSession: null }

    const timeZone = await tenantTimeZone(tx, actor.tenantId)
    const openedOn = todayIn(timeZone, open.openedAt)
    if (openedOn >= todayIn(timeZone, now)) return { staleSession: null }

    return {
      staleSession: { id: open.id, openedAt: open.openedAt.toISOString(), openedOn },
    }
  })
}

/** O fechamento impresso: a sessão, e o nome e o fuso de quem a imprime. */
export async function closingReport(
  actor: ActorContext,
  id: string,
): Promise<{ session: CashSessionDetail; tenantName: string; timeZone: string }> {
  return withTenant(actor.tenantId, async (tx) => {
    const session = await detail(tx, id)
    const [tenant, timeZone] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true } }),
      tenantTimeZone(tx, actor.tenantId),
    ])
    return { session, tenantName: tenant.name, timeZone }
  })
}

export async function tenantTimeZone(tx: TenantTransaction, tenantId: string): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({
    where: { tenantId },
    select: { timezone: true },
  })
  return settings?.timezone ?? DEFAULT_TIMEZONE
}

export async function listSessions(
  actor: ActorContext,
  query: CashSessionListQuery,
): Promise<CashSessionPage> {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.cashSession.findMany({
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, query.limit)
    const [groups, names] = await Promise.all([
      groupsOf(
        tx,
        page.map((row) => row.id),
      ),
      namesOf(
        tx,
        page.flatMap((row) => [row.openedBy, row.closedBy]),
      ),
    ])

    return {
      items: page.map((row) => summaryOf(row, groups.get(row.id) ?? [], names)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    }
  })
}

// ─── Montagem ────────────────────────────────────────────────────────────────

async function detail(tx: TenantTransaction, id: string): Promise<CashSessionDetail> {
  const session = await tx.cashSession.findFirst({ where: { id } })
  if (!session) throw notFound()

  const movements = await tx.cashMovement.findMany({
    where: { sessionId: id },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
  })
  const [groups, names, tutors] = await Promise.all([
    groupsOf(tx, [id]),
    namesOf(tx, [session.openedBy, session.closedBy, ...movements.map((row) => row.createdBy)]),
    tutorNamesOfPayments(
      tx,
      movements.filter((row) => row.sourceType === 'PAYMENT').map((row) => row.sourceId),
    ),
  ])

  return {
    ...summaryOf(session, groups.get(id) ?? [], names),
    movements: movements.map((row): CashMovementResponse => ({
      id: row.id,
      type: row.type,
      method: row.method as CashMethod,
      amountCents: Number(row.amountCents),
      description: describe(row.type, row.reason, row.sourceId ? tutors.get(row.sourceId) : null),
      createdByName: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
      occurredAt: row.occurredAt.toISOString(),
    })),
  }
}

function summaryOf(
  session: SessionRow,
  groups: GroupRow[],
  names: ReadonlyMap<string, string>,
): CashSessionSummary {
  const expected = new Map<CashMethod, number>()
  let receivedCents = 0
  for (const group of groups) {
    const method = group.method as CashMethod
    expected.set(method, (expected.get(method) ?? 0) + group.total)
    if (RECEIPT_TYPES.includes(group.type as CashMovementType)) receivedCents += group.total
  }

  // Fechado, a contagem congelada manda: o esperado daquele dia é o que foi conferido,
  // e não uma soma refeita hoje.
  const stored = Array.isArray(session.closingCounts)
    ? (session.closingCounts as unknown as StoredCount[])
    : null
  const byMethod: CashMethodTotal[] = stored
    ? stored.map((row) => ({ ...row }))
    : CASH_METHODS.filter((method) => method === 'CASH' || expected.has(method)).map((method) => ({
        method,
        expectedCents: expected.get(method) ?? 0,
        countedCents: null,
      }))

  return {
    id: session.id,
    status: session.status,
    openedAt: session.openedAt.toISOString(),
    openedByName: session.openedBy ? (names.get(session.openedBy) ?? null) : null,
    openingFloatCents: Number(session.openingFloatCents),
    closedAt: session.closedAt?.toISOString() ?? null,
    closedByName: session.closedBy ? (names.get(session.closedBy) ?? null) : null,
    byMethod,
    receivedCents,
    differenceCents: session.differenceCents === null ? null : Number(session.differenceCents),
    closingNotes: session.closingNotes,
  }
}

function describe(
  type: CashMovementType,
  reason: string | null,
  tutorName: string | null | undefined,
): string {
  const label = CASH_MOVEMENT_LABELS[type]
  switch (type) {
    case 'TUTOR_PAYMENT':
    case 'PAYMENT_REVERSAL':
      return tutorName ? `${label} · ${tutorName}` : label
    case 'OPENING_FLOAT':
      return label
    default:
      return reason ? `${label} · ${reason}` : label
  }
}

async function groupsOf(
  tx: TenantTransaction,
  sessionIds: string[],
): Promise<Map<string, GroupRow[]>> {
  const map = new Map<string, GroupRow[]>()
  if (sessionIds.length === 0) return map
  const rows = await tx.cashMovement.groupBy({
    by: ['sessionId', 'method', 'type'],
    where: { sessionId: { in: sessionIds } },
    _sum: { amountCents: true },
  })
  for (const row of rows) {
    const list = map.get(row.sessionId) ?? []
    list.push({
      sessionId: row.sessionId,
      method: row.method,
      type: row.type,
      total: Number(row._sum.amountCents ?? 0),
    })
    map.set(row.sessionId, list)
  }
  return map
}

async function expectedByMethod(
  tx: TenantTransaction,
  sessionId: string,
): Promise<Map<CashMethod, number>> {
  const groups = (await groupsOf(tx, [sessionId])).get(sessionId) ?? []
  const map = new Map<CashMethod, number>()
  for (const group of groups) {
    const method = group.method as CashMethod
    map.set(method, (map.get(method) ?? 0) + group.total)
  }
  return map
}

async function expectedCash(tx: TenantTransaction, sessionId: string): Promise<number> {
  return (await expectedByMethod(tx, sessionId)).get('CASH') ?? 0
}

async function namesOf(
  tx: TenantTransaction,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))]
  if (unique.length === 0) return new Map()
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true },
  })
  return new Map(users.map((user) => [user.id, user.fullName]))
}

/**
 * O nome do tutor de cada pagamento, lido na hora de mostrar.
 *
 * O movimento não guarda o nome de propósito: copiado para `cash_movements`, ele
 * sobreviveria à anonimização do tutor (art. 18 da LGPD), que só reescreve `tutors`.
 */
async function tutorNamesOfPayments(
  tx: TenantTransaction,
  paymentIds: (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(paymentIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const payments = await tx.payment.findMany({
    where: { id: { in: ids } },
    select: { id: true, tutorId: true },
  })
  const tutors = await tx.tutor.findMany({
    where: { id: { in: [...new Set(payments.map((row) => row.tutorId))] } },
    select: { id: true, fullName: true },
  })
  const byTutor = new Map(tutors.map((tutor) => [tutor.id, tutor.fullName]))
  return new Map(
    payments
      .map((payment) => [payment.id, byTutor.get(payment.tutorId)] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== undefined),
  )
}

function signedBRL(cents: number): string {
  return cents > 0 ? `sobram ${formatBRL(cents)}` : `faltam ${formatBRL(-cents)}`
}
