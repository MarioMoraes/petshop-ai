import type { TenantTransaction } from '@petshop/db'
import { DEFAULT_TIMEZONE } from '@petshop/shared-types'

/**
 * Conversão entre o relógio do petshop e o instante em UTC.
 *
 * O banco guarda instantes (`timestamptz`), mas a jornada do profissional e o
 * `business_hours` do tenant guardam **hora de parede**: "10:00" é o que a Ana lê no
 * relógio dela, não um deslocamento a partir da meia-noite UTC. Somar esses minutos
 * sobre a meia-noite UTC — que é o que a agenda fazia — desloca o dia inteiro pelo
 * offset do fuso: em São Paulo, a jornada de 10:00–18:00 virava 07:00–15:00.
 *
 * As funções puras mudaram-se para `@petshop/shared-types` quando o MOD-TAXI passou a
 * precisar da mesma conta para a jornada do motorista. O que sobra aqui é o que toca
 * o banco.
 */

export { DEFAULT_TIMEZONE, addDays, weekdayOf, zonedDate, zonedMidnight } from '@petshop/shared-types'

/** O fuso do tenant (RN-19). Lido sob RLS: a transação já está no tenant certo. */
export async function loadTimezone(tx: TenantTransaction): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  return settings?.timezone ?? DEFAULT_TIMEZONE
}
