import type { TenantTransaction } from '@petshop/db'

/**
 * Conversão entre o relógio do petshop e o instante em UTC.
 *
 * O banco guarda instantes (`timestamptz`), mas a jornada do profissional e o
 * `business_hours` do tenant guardam **hora de parede**: "10:00" é o que a Ana lê no
 * relógio dela, não um deslocamento a partir da meia-noite UTC. Somar esses minutos
 * sobre a meia-noite UTC — que é o que a agenda fazia — desloca o dia inteiro pelo
 * offset do fuso: em São Paulo, a jornada de 10:00–18:00 virava 07:00–15:00.
 *
 * A conversão é feita dia a dia, com o offset **daquele** dia, e não com uma
 * constante: o horário de verão muda o offset, e uma subtração fixa erraria a agenda
 * exatamente na virada.
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo'

/** O fuso do tenant (RN-19). Lido sob RLS: a transação já está no tenant certo. */
export async function loadTimezone(tx: TenantTransaction): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  return settings?.timezone ?? DEFAULT_TIMEZONE
}

/**
 * A meia-noite de um dia civil, no fuso pedido, como instante UTC.
 *
 * Calculada por diferença de offset, e não por aritmética de UTC: o horário de verão
 * muda a duração real do dia, e somar 24h daria o instante errado exatamente na
 * madrugada em que a agenda mais precisa acertar.
 */
export function zonedMidnight(date: string, timezone: string): Date {
  const naive = new Date(`${date}T00:00:00Z`)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(naive).map((part) => [part.type, part.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  // A diferença entre o instante formatado no fuso e o instante original é o offset.
  return new Date(naive.getTime() + (naive.getTime() - asUtc))
}

/** O dia civil (`YYYY-MM-DD`) em que um instante cai, no fuso do tenant. */
export function zonedDate(instant: Date, timezone: string): string {
  // `en-CA` formata como `YYYY-MM-DD`, que é exatamente a chave que usamos.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/** Anda dias sobre um `YYYY-MM-DD`, sem passar por fuso nenhum. */
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

/** O dia da semana (0 = domingo) de um `YYYY-MM-DD`, sem ambiguidade de fuso. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}
