import { withTenant, type TenantTransaction } from '@petshop/db'
import { recordAudit } from '../../shared/audit.js'
import { invalid, notFound } from './errors.js'
import { tenantOptions, type ActorContext } from '../schedule-catalog/actor.js'
import { createBooking } from './booking.js'

/**
 * Recorrência (MOD-AGENDA-05).
 *
 * RN-14: a série é **materializada**, não uma regra viva. As ocorrências são
 * agendamentos reais, gerados até 12 semanas à frente e estendidos por job semanal.
 *
 * A alternativa — guardar a RRULE e interpretá-la em toda leitura — parece mais
 * limpa e não é: a consulta mais frequente do sistema viraria avaliação de calendário,
 * e nada que acontece com **uma** ocorrência (bloqueio, remarcação, cancelamento)
 * poderia ser gravado sem inventar uma tabela de exceções ao lado. Materializar troca
 * espaço em disco, que é barato, por simplicidade em todo o resto.
 */

/** RN-14: doze semanas. Além disso, é o job semanal que estende. */
export const MATERIALIZATION_WEEKS = 12

export interface CreateRecurrenceInput {
  petId: string
  professionalId: string
  serviceIds: string[]
  startsAt: Date
  rrule: string
  until?: Date | undefined
}

export interface SkippedOccurrence {
  startsAt: string
  reason: string
}

// ─── RRULE ───────────────────────────────────────────────────────────────────

interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  interval: number
  /** Dias da semana em `FREQ=WEEKLY;BYDAY=TU,TH`; vazio usa o dia de `startsAt`. */
  byDay: number[]
  count: number | null
  until: Date | null
}

const DAY_CODES: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
}

/**
 * Um interpretador **deliberadamente pequeno** de RRULE.
 *
 * O AC-02 aceita só `DAILY`, `WEEKLY` e `MONTHLY`, e nenhum petshop marca banho por
 * `BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR`. Trazer uma biblioteca de iCal completa para
 * isto seria carregar o peso de um padrão inteiro — com seus casos de borda e suas
 * CVEs — para usar três frequências.
 */
export function parseRRule(rrule: string): ParsedRule {
  const body = rrule.replace(/^RRULE:/i, '').trim()
  const parts = new Map<string, string>()
  for (const chunk of body.split(';')) {
    const [key, value] = chunk.split('=')
    if (key && value) parts.set(key.toUpperCase(), value.toUpperCase())
  }

  const freq = parts.get('FREQ')
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    throw invalid('A recorrência aceita apenas repetição diária, semanal ou mensal', [
      { field: 'rrule', message: 'FREQ deve ser DAILY, WEEKLY ou MONTHLY' },
    ])
  }

  const interval = Number(parts.get('INTERVAL') ?? '1')
  if (!Number.isInteger(interval) || interval < 1 || interval > 12) {
    throw invalid('O intervalo da recorrência precisa estar entre 1 e 12', [
      { field: 'rrule', message: 'INTERVAL inválido' },
    ])
  }

  const byDay = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((code) => DAY_CODES[code.trim()])
    .filter((day): day is number => day !== undefined)

  const countRaw = parts.get('COUNT')
  const count = countRaw ? Number(countRaw) : null
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > 365)) {
    throw invalid('COUNT da recorrência precisa estar entre 1 e 365', [
      { field: 'rrule', message: 'COUNT inválido' },
    ])
  }

  const untilRaw = parts.get('UNTIL')
  const until = untilRaw ? parseIcalDate(untilRaw) : null

  return { freq, interval, byDay, count, until }
}

function parseIcalDate(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value)
  if (!match) return null
  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? '0'),
      Number(match[5] ?? '0'),
      Number(match[6] ?? '0'),
    ),
  )
}

/**
 * As datas da série entre dois instantes.
 *
 * A hora do dia é sempre a de `startsAt`: mudar de dia não pode mudar o horário do
 * banho. `BYDAY` só expande a semana; a hora vem da primeira ocorrência.
 *
 * `to` é **exclusivo**, como toda janela deste módulo. Com as duas pontas inclusivas,
 * "as próximas 12 semanas" de uma série semanal daria 13 ocorrências — a primeira e a
 * do mesmo dia da semana 12 semanas depois. O `UNTIL` da RRULE continua inclusivo,
 * porque é o que o iCal define.
 */
export function expandOccurrences(
  rule: ParsedRule,
  startsAt: Date,
  from: Date,
  to: Date,
): Date[] {
  const hours = startsAt.getUTCHours()
  const minutes = startsAt.getUTCMinutes()
  const occurrences: Date[] = []
  // UNTIL do iCal é inclusivo; a janela deste módulo não. O milissegundo reconcilia
  // as duas convenções sem espalhar `<=` pelo resto do arquivo.
  const untilExclusive = rule.until ? new Date(rule.until.getTime() + 1) : null
  const hardEnd = untilExclusive && untilExclusive < to ? untilExclusive : to

  if (rule.freq === 'MONTHLY') {
    const cursor = new Date(startsAt)
    while (cursor < hardEnd && occurrences.length < 400) {
      if (cursor >= from) occurrences.push(new Date(cursor))
      cursor.setUTCMonth(cursor.getUTCMonth() + rule.interval)
    }
  } else {
    const stepDays = rule.freq === 'DAILY' ? rule.interval : 1
    const days = rule.freq === 'WEEKLY' && rule.byDay.length > 0 ? rule.byDay : null

    const cursor = new Date(startsAt)
    // Semanal com BYDAY caminha dia a dia e filtra; o `interval` conta semanas
    // inteiras a partir da semana da primeira ocorrência.
    const weekZero = startOfWeek(startsAt)

    while (cursor < hardEnd && occurrences.length < 400) {
      const matchesDay = days === null || days.includes(cursor.getUTCDay())
      const weeksSinceStart = Math.floor(
        (startOfWeek(cursor).getTime() - weekZero.getTime()) / (7 * 24 * 3_600_000),
      )
      const matchesInterval =
        rule.freq === 'DAILY' ? true : weeksSinceStart % rule.interval === 0

      if (cursor >= from && matchesDay && matchesInterval) {
        const at = new Date(cursor)
        at.setUTCHours(hours, minutes, 0, 0)
        if (at >= from && at < hardEnd) occurrences.push(at)
      }
      cursor.setUTCDate(cursor.getUTCDate() + (days === null ? stepDays : 1))
    }
  }

  return rule.count ? occurrences.slice(0, rule.count) : occurrences
}

function startOfWeek(date: Date): Date {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  copy.setUTCDate(copy.getUTCDate() - copy.getUTCDay())
  return copy
}

// ─── Criação da série ────────────────────────────────────────────────────────

/**
 * AC-01 e AC-03.
 *
 * **A série não falha por causa de uma ocorrência.** Se a terça da semana 5 cai em
 * feriado, as outras onze são criadas e essa entra em `skipped[]` com o motivo —
 * recusar as doze obrigaria a recepção a agendar tudo à mão, que é exatamente o
 * trabalho que a recorrência existe para poupar.
 */
export async function createRecurrence(actor: ActorContext, input: CreateRecurrenceInput) {
  const rule = parseRRule(input.rrule)

  const horizon = new Date(input.startsAt)
  horizon.setUTCDate(horizon.getUTCDate() + MATERIALIZATION_WEEKS * 7)
  const until = input.until && input.until < horizon ? input.until : horizon

  const recurrence = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertReferencesExist(tx, input)
      return tx.appointmentRecurrence.create({
        data: {
          tenantId: actor.tenantId,
          petId: input.petId,
          professionalId: input.professionalId,
          rrule: input.rrule,
          startsAt: input.startsAt,
          until: input.until ?? null,
          serviceIds: input.serviceIds,
          createdBy: actor.actorUserId ?? null,
        },
      })
    },
    tenantOptions(actor),
  )

  const dates = expandOccurrences(rule, input.startsAt, input.startsAt, until)
  const { created, skipped } = await materialize(actor, recurrence.id, input, dates)

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await tx.appointmentRecurrence.update({
        where: { id: recurrence.id },
        data: { materializedUntil: until },
      })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'recurrence.created',
        entity: 'recurrence',
        entityId: recurrence.id,
        after: { rrule: input.rrule, generated: created.length, skipped: skipped.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  return {
    recurrenceId: recurrence.id,
    generated: created.length,
    appointmentIds: created,
    skipped,
  }
}

async function assertReferencesExist(tx: TenantTransaction, input: CreateRecurrenceInput) {
  const pet = await tx.pet.findFirst({ where: { id: input.petId }, select: { id: true } })
  if (!pet) throw notFound('Pet não encontrado')

  const professional = await tx.professional.findFirst({
    where: { id: input.professionalId, active: true, deletedAt: null },
    select: { id: true },
  })
  if (!professional) throw notFound('Profissional não encontrado')

  const services = await tx.service.findMany({
    where: { id: { in: input.serviceIds }, deletedAt: null, active: true },
    select: { id: true },
  })
  if (services.length !== new Set(input.serviceIds).size) {
    throw notFound('Um dos serviços informados não existe ou está desativado')
  }
}

/**
 * Cria uma ocorrência por data, engolindo a falha de cada uma.
 *
 * As ocorrências são criadas **em sequência**, e não em paralelo: cada uma abre uma
 * transação serializável sobre a janela do mesmo profissional, e disparar doze juntas
 * faria elas se abortarem umas às outras por conflito de serialização.
 */
async function materialize(
  actor: ActorContext,
  recurrenceId: string,
  input: CreateRecurrenceInput,
  dates: Date[],
): Promise<{ created: string[]; skipped: SkippedOccurrence[] }> {
  const created: string[] = []
  const skipped: SkippedOccurrence[] = []

  for (const startsAt of dates) {
    try {
      const booking = await createBooking(actor, {
        petId: input.petId,
        professionalId: input.professionalId,
        startsAt,
        items: input.serviceIds.map((serviceId) => ({ serviceId })),
        source: 'RECURRENCE',
        // A série inteira é criada num ato só; exigir reconhecimento de alerta por
        // ocorrência transformaria doze semanas em doze confirmações.
        acknowledgedAlerts: true,
      })
      created.push(booking.id)
      await linkToRecurrence(actor, booking.id, recurrenceId)
    } catch (error) {
      skipped.push({
        startsAt: startsAt.toISOString(),
        reason: error instanceof Error ? error.message : 'Não foi possível agendar',
      })
    }
  }

  return { created, skipped }
}

async function linkToRecurrence(actor: ActorContext, appointmentId: string, recurrenceId: string) {
  await withTenant(actor.tenantId, (tx) =>
    tx.appointment.update({ where: { id: appointmentId }, data: { recurrenceId } }),
  )
}

// ─── Edição e encerramento ───────────────────────────────────────────────────

export type RecurrenceScope = 'THIS_ONE' | 'THIS_AND_FUTURE' | 'ALL'

/**
 * AC-04: encerrar a série.
 *
 * **Ocorrências já concluídas nunca são tocadas**, em nenhum escopo — um atendimento
 * que aconteceu não deixa de ter acontecido porque a série foi encerrada. O mesmo
 * vale para as que já estão em curso.
 */
export async function endRecurrence(
  actor: ActorContext,
  recurrenceId: string,
  scope: RecurrenceScope = 'THIS_AND_FUTURE',
) {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const recurrence = await tx.appointmentRecurrence.findFirst({
        where: { id: recurrenceId },
      })
      if (!recurrence) throw notFound('Série não encontrada')

      const futuras = await tx.appointment.findMany({
        where: {
          recurrenceId,
          startsAt: { gt: new Date() },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        select: { id: true },
      })

      if (scope !== 'THIS_ONE' && futuras.length > 0) {
        const ids = futuras.map((row) => row.id)
        await tx.appointment.updateMany({
          where: { id: { in: ids } },
          // Encerrar série não é falta do tutor: nunca é tardio.
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledLate: false },
        })
        for (const id of ids) {
          await tx.appointmentStatusLog.create({
            data: {
              tenantId: actor.tenantId,
              appointmentId: id,
              fromStatus: 'CONFIRMED',
              toStatus: 'CANCELLED',
              changedBy: actor.actorUserId ?? null,
              reason: 'Série encerrada',
            },
          })
        }
      }

      await tx.appointmentRecurrence.update({
        where: { id: recurrenceId },
        data: { active: false },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'recurrence.ended',
        entity: 'recurrence',
        entityId: recurrenceId,
        after: { scope, cancelled: scope === 'THIS_ONE' ? 0 : futuras.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { cancelled: scope === 'THIS_ONE' ? 0 : futuras.length }
    },
    tenantOptions(actor),
  )
}
