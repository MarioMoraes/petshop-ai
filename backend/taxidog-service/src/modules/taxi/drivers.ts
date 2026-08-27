import type { TenantTransaction } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  addDays,
  weekdayOf,
  zonedDate,
  zonedMidnight,
} from '@petshop/shared-types'
import { countOverlappingRides, effectiveCapacity } from './conflicts.js'

/**
 * Disponibilidade do motorista (MOD-TAXI-03).
 *
 * O motorista **é** um `professionals` com `role_key = 'DRIVER'` (RN-03): jornada em
 * `professional_schedules`, folga em `calendar_blocks`, capacidade em
 * `max_concurrent_pets`. Este módulo não cria uma segunda noção de escala — ele lê a
 * do MOD-AGENDA.
 *
 * A jornada é **hora de parede** no fuso do tenant, convertida em instantes dia a dia
 * pelas funções de `@petshop/shared-types`. Tratá-la como se já fosse UTC deslocaria
 * a rota inteira pelo offset do fuso.
 */

const MS_PER_MINUTE = 60_000
export const DRIVER_ROLE_KEY = 'DRIVER'

export type WindowCheck =
  | { ok: true }
  | { ok: false; reason: 'OUT_OF_SCHEDULE' | 'BLOCKED' | 'INACTIVE' }

interface Shift {
  start: number
  end: number
}

async function loadTimezone(tx: TenantTransaction): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  return settings?.timezone ?? DEFAULT_TIMEZONE
}

/**
 * As faixas de jornada que tocam o intervalo, como instantes.
 *
 * Começa um dia antes: uma jornada que atravessa a meia-noite local já está em curso
 * no instante `from`, e sair do dia civil de `from` a perderia.
 */
function shiftsBetween(
  schedules: { weekday: number; startsAtMin: number; endsAtMin: number }[],
  from: Date,
  to: Date,
  timezone: string,
): Shift[] {
  const byWeekday = new Map<number, { start: number; end: number }[]>()
  for (const row of schedules) {
    const day = byWeekday.get(row.weekday) ?? []
    day.push({ start: row.startsAtMin, end: row.endsAtMin })
    byWeekday.set(row.weekday, day)
  }

  const shifts: Shift[] = []
  let day = addDays(zonedDate(from, timezone), -1)
  const lastDay = zonedDate(to, timezone)

  while (day <= lastDay) {
    const midnight = zonedMidnight(day, timezone).getTime()
    for (const window of byWeekday.get(weekdayOf(day)) ?? []) {
      shifts.push({
        start: midnight + window.start * MS_PER_MINUTE,
        end: midnight + window.end * MS_PER_MINUTE,
      })
    }
    day = addDays(day, 1)
  }

  return shifts
}

/**
 * A janela cabe na jornada e está fora de bloqueio? (AC-02 de MOD-TAXI-03)
 *
 * Capacidade **não** é checada aqui, e de propósito: "não trabalha nesse horário" e
 * "a van está cheia" dizem coisas diferentes a quem está no balcão, e a segunda
 * precisa da transação SERIALIZABLE que a primeira não precisa.
 */
export async function checkDriverWindow(
  tx: TenantTransaction,
  driverId: string,
  windowStartsAt: Date,
  windowEndsAt: Date,
): Promise<WindowCheck> {
  const driver = await tx.professional.findFirst({
    where: { id: driverId, deletedAt: null },
    select: { active: true, schedules: true },
  })
  if (!driver) return { ok: false, reason: 'INACTIVE' }
  if (!driver.active) return { ok: false, reason: 'INACTIVE' }

  const timezone = await loadTimezone(tx)
  const shifts = shiftsBetween(driver.schedules, windowStartsAt, windowEndsAt, timezone)

  // A janela tem de caber **inteira** numa faixa. Uma coleta prometida entre 11:30 e
  // 12:30 não cabe numa jornada que para às 12:00, mesmo que comece dentro dela.
  const start = windowStartsAt.getTime()
  const end = windowEndsAt.getTime()
  const fits = shifts.some((shift) => start >= shift.start && end <= shift.end)
  if (!fits) return { ok: false, reason: 'OUT_OF_SCHEDULE' }

  const blocked = await tx.calendarBlock.findFirst({
    where: {
      startsAt: { lt: windowEndsAt },
      endsAt: { gt: windowStartsAt },
      // Bloqueio do tenant inteiro (feriado) tem `professional_id` nulo e vale para
      // todo mundo, motorista incluído.
      OR: [{ professionalId: driverId }, { professionalId: null }],
    },
    select: { id: true },
  })
  if (blocked) return { ok: false, reason: 'BLOCKED' }

  return { ok: true }
}

export interface AvailableDriver {
  id: string
  displayName: string
  capacity: number
  /** Quantas corridas já ocupam a van naquela janela. */
  occupied: number
  /** `capacity - occupied`; é o que a tela mostra como "cabem mais N". */
  remaining: number
}

/**
 * Quem pode pegar esta janela (§5, `GET /v1/taxi/drivers/available`).
 *
 * Existe para que a negação de `ERR_TAXI_006` e `ERR_TAXI_007` possa oferecer
 * alternativa no mesmo corpo: recusar sem dizer quem **pode** ir devolve a recepção
 * ao WhatsApp, que é de onde este módulo veio para tirá-la.
 */
export async function findAvailableDrivers(
  tx: TenantTransaction,
  windowStartsAt: Date,
  windowEndsAt: Date,
): Promise<AvailableDriver[]> {
  const drivers = await tx.professional.findMany({
    where: { roleKey: DRIVER_ROLE_KEY, active: true, deletedAt: null },
    select: { id: true, displayName: true, maxConcurrentPets: true },
    orderBy: { displayName: 'asc' },
  })

  const available: AvailableDriver[] = []
  for (const driver of drivers) {
    const window = await checkDriverWindow(tx, driver.id, windowStartsAt, windowEndsAt)
    if (!window.ok) continue

    const occupied = await countOverlappingRides(tx, driver.id, windowStartsAt, windowEndsAt)
    const capacity = effectiveCapacity(driver.maxConcurrentPets, null)
    if (occupied >= capacity) continue

    available.push({
      id: driver.id,
      displayName: driver.displayName,
      capacity,
      occupied,
      remaining: capacity - occupied,
    })
  }

  return available
}
