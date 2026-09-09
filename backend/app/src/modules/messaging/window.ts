import { DEFAULT_TIMEZONE, todayIn, zonedMidnight } from '@petshop/shared-types'
import type { MessageCategory } from '@petshop/shared-types'

/**
 * A janela de silêncio (decisão 16, RN-04 do PRD).
 *
 * Padrão 08:00–20:00 no fuso do tenant, configurável. Mensagem gerada fora dela fica
 * `SCHEDULED` para a abertura seguinte — **nunca é descartada**. A única categoria que
 * atravessa é `OPERATIONAL`: o motorista está na rua agora, e um aviso de coleta às
 * 7h30 é um fato sobre o pet, não uma promoção.
 */

export interface QuietWindow {
  quietStartMin: number
  quietEndMin: number
  marketingWeekdaysOnly: boolean
  timezone: string
}

/** Minutos desde a meia-noite local, no fuso informado. */
export function minutesOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  // `hour12: false` devolve 24 à meia-noite em alguns runtimes; 24:00 é 00:00.
  return (hour % 24) * 60 + minute
}

/** Dia da semana local: 0 = domingo. */
export function weekdayIn(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name)
}

function atLocalMinute(dateISO: string, timeZone: string, minute: number): Date {
  return new Date(zonedMidnight(dateISO, timeZone).getTime() + minute * 60_000)
}

/**
 * Quando esta mensagem pode sair.
 *
 * Devolve `null` quando pode sair agora. Caso contrário, o instante da próxima
 * abertura — que pode ser hoje mais tarde, amanhã, ou segunda-feira, se for marketing
 * num sábado com `marketingWeekdaysOnly` ligado.
 */
export function nextOpening(
  now: Date,
  category: MessageCategory,
  window: QuietWindow,
): Date | null {
  // A exceção do Taxi Dog. Está aqui, e não no chamador, porque a regra precisa ser
  // impossível de esquecer: qualquer lugar que pergunte "posso enviar?" recebe a
  // resposta com a exceção já aplicada.
  if (category === 'OPERATIONAL') return null

  const timeZone = window.timezone || DEFAULT_TIMEZONE
  const marketing = category === 'MARKETING'

  let dateISO = todayIn(timeZone, now)
  const current = minutesOfDay(now, timeZone)

  // Sete voltas cobrem a semana inteira: mais que isso significaria uma configuração
  // que nunca abre, e o CHECK do banco já impede a janela vazia.
  for (let offset = 0; offset < 8; offset += 1) {
    const opensAt = atLocalMinute(dateISO, timeZone, window.quietStartMin)
    const weekday = weekdayIn(offset === 0 ? now : opensAt, timeZone)
    const dayAllowed = !marketing || !window.marketingWeekdaysOnly || (weekday >= 1 && weekday <= 5)

    if (dayAllowed) {
      if (offset === 0 && current >= window.quietStartMin && current < window.quietEndMin) {
        return null
      }
      if (offset > 0 || current < window.quietStartMin) return opensAt
      // Passou do fim da janela num dia liberado: cai para o próximo.
    }
    dateISO = nextDay(dateISO)
  }

  return null
}

function nextDay(dateISO: string): string {
  const next = new Date(`${dateISO}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/** O dia civil do tenant — a chave do contador de teto diário. */
export function tenantToday(timeZone: string, now = new Date()): string {
  return todayIn(timeZone || DEFAULT_TIMEZONE, now)
}
