import type { TenantTransaction } from '@petshop/db'
import { SCHEDULE_GRID_MIN } from '@petshop/shared-types'
import { OCCUPYING_STATUSES } from './conflicts.js'
import { addDays, loadTimezone, weekdayOf, zonedDate, zonedMidnight } from './timezone.js'

/**
 * Disponibilidade (MOD-AGENDA-11).
 *
 * O algoritmo é uma subtração em três camadas, nesta ordem:
 *
 *     jornada do profissional  (o que ele trabalha)
 *   − bloqueios                (folga, feriado, manutenção)
 *   − ocupação acima do limite (RN-02: contagem, não existência)
 *   = horários oferecíveis
 *
 * A varredura é feita na grade de 15 minutos e **não** em cima dos vãos livres. A
 * diferença importa: com capacidade paralela, "vão livre" não é um conceito bem
 * definido — às 09:00 pode haver dois atendimentos em curso e ainda caber um terceiro.
 * O único jeito honesto de saber se um horário cabe é perguntar, para cada início
 * candidato, quantos atendimentos cobrem cada instante da duração pedida.
 *
 * Agendamento e bloqueio são **instantes** (`timestamptz`), e a aritmética daqui é
 * toda sobre eles. A jornada é a exceção, e a única: ela é hora de parede no fuso do
 * tenant (RN-19), convertida em instantes por `shiftsBetween`. Tratá-la como se já
 * fosse UTC deslocava a agenda inteira pelo offset do fuso — era o bug de "a agenda
 * vai até as 18h, mas o sistema só oferece até as 14h".
 */

const MS_PER_MINUTE = 60_000

export interface AvailabilityRequest {
  professionalIds: string[]
  /** Duração já calculada para **este** pet — porte e pelagem mudam o buraco. */
  durationMin: number
  from: Date
  to: Date
  /** Agendamento sendo remarcado, que não deve conflitar consigo mesmo. */
  excludeAppointmentId?: string
}

export interface AvailabilitySlot {
  professionalId: string
  startsAt: Date
  endsAt: Date
}

interface Window {
  start: number
  end: number
}

/** Um agendamento já marcado, reduzido ao que o cálculo precisa. */
interface Busy {
  professionalId: string
  start: number
  end: number
}

interface ProfessionalPlan {
  id: string
  maxConcurrentPets: number
  /** Faixas de jornada por dia da semana (0 = domingo). */
  scheduleByWeekday: Map<number, Window[]>
}

/**
 * Monta os horários livres.
 *
 * Devolve também `nextAvailable`: o AC-02 diz que uma lista vazia sozinha obriga o
 * tutor a adivinhar a próxima consulta. Ele é procurado além da janela pedida, até um
 * teto — sem teto, uma agenda permanentemente lotada varreria o calendário inteiro.
 */
export async function findAvailability(
  tx: TenantTransaction,
  request: AvailabilityRequest,
): Promise<{ slots: AvailabilitySlot[]; nextAvailable: Date | null }> {
  if (request.professionalIds.length === 0) return { slots: [], nextAvailable: null }

  const plans = await loadPlans(tx, request.professionalIds)
  if (plans.length === 0) return { slots: [], nextAvailable: null }

  const timezone = await loadTimezone(tx)

  const slots = await scan(tx, plans, request, request.from, request.to, timezone)
  if (slots.length > 0) return { slots, nextAvailable: slots[0]?.startsAt ?? null }

  // Nada na janela pedida: procura à frente, com teto, e devolve só o primeiro.
  const horizonEnd = new Date(request.to.getTime() + NEXT_AVAILABLE_HORIZON_MS)
  const ahead = await scan(tx, plans, request, request.to, horizonEnd, timezone, true)
  return { slots: [], nextAvailable: ahead[0]?.startsAt ?? null }
}

/** Quatro semanas além da janela pedida. Além disso, "não temos" é a resposta certa. */
const NEXT_AVAILABLE_HORIZON_MS = 28 * 24 * 60 * MS_PER_MINUTE

async function loadPlans(
  tx: TenantTransaction,
  professionalIds: string[],
): Promise<ProfessionalPlan[]> {
  const rows = await tx.professional.findMany({
    where: { id: { in: professionalIds }, active: true, deletedAt: null },
    include: { schedules: true },
  })

  return rows.map((row) => {
    const scheduleByWeekday = new Map<number, Window[]>()
    for (const window of row.schedules) {
      const day = scheduleByWeekday.get(window.weekday) ?? []
      day.push({ start: window.startsAtMin, end: window.endsAtMin })
      scheduleByWeekday.set(window.weekday, day)
    }
    return {
      id: row.id,
      maxConcurrentPets: row.maxConcurrentPets,
      scheduleByWeekday,
    }
  })
}

async function scan(
  tx: TenantTransaction,
  plans: ProfessionalPlan[],
  request: AvailabilityRequest,
  from: Date,
  to: Date,
  timezone: string,
  stopAtFirst = false,
): Promise<AvailabilitySlot[]> {
  const professionalIds = plans.map((plan) => plan.id)

  // Uma consulta para o período inteiro, e não uma por dia: o custo do algoritmo tem
  // de estar na aritmética, não no banco.
  const [busyRows, blockRows] = await Promise.all([
    tx.appointment.findMany({
      where: {
        professionalId: { in: professionalIds },
        status: { in: [...OCCUPYING_STATUSES] },
        startsAt: { lt: to },
        endsAt: { gt: from },
        ...(request.excludeAppointmentId ? { id: { not: request.excludeAppointmentId } } : {}),
      },
      select: { professionalId: true, startsAt: true, endsAt: true },
    }),
    tx.calendarBlock.findMany({
      where: {
        startsAt: { lt: to },
        endsAt: { gt: from },
        // Bloqueio de tenant (feriado) vale para todo mundo, daí o `null` na lista.
        OR: [{ professionalId: { in: professionalIds } }, { professionalId: null }],
      },
      select: { professionalId: true, startsAt: true, endsAt: true },
    }),
  ])

  const busy: Busy[] = busyRows.map((row) => ({
    professionalId: row.professionalId,
    start: row.startsAt.getTime(),
    end: row.endsAt.getTime(),
  }))

  const durationMs = request.durationMin * MS_PER_MINUTE
  const stepMs = SCHEDULE_GRID_MIN * MS_PER_MINUTE
  const slots: AvailabilitySlot[] = []

  for (const plan of plans) {
    const blocks = blockRows
      .filter((row) => row.professionalId === null || row.professionalId === plan.id)
      .map((row) => ({ start: row.startsAt.getTime(), end: row.endsAt.getTime() }))
    const mine = busy.filter((row) => row.professionalId === plan.id)

    for (const shift of shiftsBetween(plan, from, to, timezone)) {
      // Alinha o primeiro candidato à grade, para não oferecer 08:07.
      let cursor = alignUp(Math.max(shift.start, from.getTime()), stepMs)

      while (cursor + durationMs <= Math.min(shift.end, to.getTime())) {
        const end = cursor + durationMs

        if (
          !overlapsAny(cursor, end, blocks) &&
          fitsCapacity(cursor, end, mine, plan.maxConcurrentPets, stepMs)
        ) {
          slots.push({
            professionalId: plan.id,
            startsAt: new Date(cursor),
            endsAt: new Date(end),
          })
          if (stopAtFirst) return slots
        }
        cursor += stepMs
      }
    }
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

/**
 * As faixas de trabalho concretas entre dois instantes.
 *
 * A jornada é semanal e abstrata ("segunda, 10:00 às 18:00"); aqui ela vira intervalos
 * de verdade, dia a dia.
 *
 * Os minutos são **hora de parede no fuso do tenant** — é o que o profissional digita
 * na tela de jornada e o que ele lê no relógio. Somá-los sobre a meia-noite UTC, como
 * esta função fazia, deslocava a jornada inteira pelo offset do fuso: em São Paulo,
 * 10:00–18:00 virava 07:00–15:00, e a agenda oferecia manhã cedo e fechava às duas da
 * tarde. Por isso a âncora é a meia-noite **local** de cada dia civil percorrido, com
 * o offset daquele dia — o que também mantém a conta certa na virada do horário de
 * verão.
 */
function shiftsBetween(
  plan: ProfessionalPlan,
  from: Date,
  to: Date,
  timezone: string,
): Window[] {
  const shifts: Window[] = []

  // Começa um dia antes: uma jornada que atravessa a meia-noite local já está em
  // curso no instante `from`, e sair do dia civil de `from` a perderia.
  let day = addDays(zonedDate(from, timezone), -1)
  const lastDay = zonedDate(to, timezone)

  while (day <= lastDay) {
    const midnight = zonedMidnight(day, timezone).getTime()
    for (const window of plan.scheduleByWeekday.get(weekdayOf(day)) ?? []) {
      shifts.push({
        start: midnight + window.start * MS_PER_MINUTE,
        end: midnight + window.end * MS_PER_MINUTE,
      })
    }
    day = addDays(day, 1)
  }

  return shifts
}

function alignUp(value: number, step: number): number {
  return Math.ceil(value / step) * step
}

function overlapsAny(start: number, end: number, windows: Window[]): boolean {
  return windows.some((window) => start < window.end && end > window.start)
}

/**
 * O horário cabe na capacidade do profissional?
 *
 * Verifica **cada passo da grade** dentro da duração pedida, e não só o início. Um
 * atendimento de 90 min pode começar num instante em que há espaço e cruzar, no meio,
 * um pico em que o limite já está cheio — checar só a borda ofereceria um horário que
 * não cabe.
 */
function fitsCapacity(
  start: number,
  end: number,
  busy: Busy[],
  limit: number,
  stepMs: number,
): boolean {
  for (let instant = start; instant < end; instant += stepMs) {
    const concurrent = busy.filter((row) => row.start <= instant && row.end > instant).length
    if (concurrent >= limit) return false
  }
  return true
}

/**
 * A janela cai na jornada e fora de bloqueio?
 *
 * Checa **só** jornada e bloqueio, deliberadamente sem capacidade. Os dois motivos
 * de recusa dizem coisas diferentes a quem está no balcão — "Ana não trabalha nesse
 * horário" (ERR_AGENDA_005) e "Ana trabalha, mas já tem 3 pets" (ERR_AGENDA_004) —
 * e misturá-los produz a mensagem errada no caso mais comum, que é o de lotação.
 *
 * Compartilha `shiftsBetween` com `findAvailability` para que as duas não divirjam:
 * a agenda oferecendo um horário que a criação recusa seria pior que qualquer erro
 * de mensagem.
 */
export async function checkWindow(
  tx: TenantTransaction,
  professionalId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<{ ok: true } | { ok: false; reason: 'OUT_OF_SHIFT' | 'BLOCKED' }> {
  const [plan] = await loadPlans(tx, [professionalId])
  if (!plan) return { ok: false, reason: 'OUT_OF_SHIFT' }

  const start = startsAt.getTime()
  const end = endsAt.getTime()

  // A janela tem de caber **inteira** numa faixa de jornada. Um banho que começa às
  // 11:30 e termina 12:30 não cabe numa jornada que para 12:00, mesmo que o início
  // esteja dentro dela.
  const shifts = shiftsBetween(plan, startsAt, endsAt, await loadTimezone(tx))
  const fits = shifts.some((shift) => start >= shift.start && end <= shift.end)
  if (!fits) return { ok: false, reason: 'OUT_OF_SHIFT' }

  const blocked = await tx.calendarBlock.findFirst({
    where: {
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      OR: [{ professionalId }, { professionalId: null }],
    },
    select: { id: true },
  })
  if (blocked) return { ok: false, reason: 'BLOCKED' }

  return { ok: true }
}
