import { describe, expect, it } from 'vitest'
import { todayIn, zonedDayRange } from './timezone.js'

const SP = 'America/Sao_Paulo'

describe('todayIn', () => {
  it('devolve a data do fuso, não a do servidor', () => {
    // 01:00 UTC de 27/08 ainda é 26/08 às 22h em São Paulo.
    const instante = new Date('2026-08-27T01:00:00Z')

    expect(todayIn(SP, instante)).toBe('2026-08-26')
    expect(todayIn('UTC', instante)).toBe('2026-08-27')
  })

  it('formata como YYYY-MM-DD, que é o formato das rotas de data', () => {
    expect(todayIn(SP, new Date('2026-01-05T15:00:00Z'))).toBe('2026-01-05')
  })
})

describe('zonedDayRange', () => {
  it('o dia de São Paulo começa às 03:00 UTC, não às 00:00', () => {
    const { from, to } = zonedDayRange('2026-08-26', SP)

    expect(from.toISOString()).toBe('2026-08-26T03:00:00.000Z')
    expect(to.toISOString()).toBe('2026-08-27T02:59:59.999Z')
  })

  it('em UTC o dia é o dia', () => {
    const { from, to } = zonedDayRange('2026-08-26', 'UTC')

    expect(from.toISOString()).toBe('2026-08-26T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-08-26T23:59:59.999Z')
  })

  it('cobre 24 horas cheias', () => {
    const { from, to } = zonedDayRange('2026-08-26', SP)
    expect(to.getTime() - from.getTime()).toBe(24 * 3_600_000 - 1)
  })

  it('funciona em fuso que ainda pratica horário de verão', () => {
    // Nova York: EST (−5) em janeiro, EDT (−4) em julho. Um deslocamento fixo erraria
    // metade do ano.
    expect(zonedDayRange('2026-01-15', 'America/New_York').from.toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    )
    expect(zonedDayRange('2026-07-15', 'America/New_York').from.toISOString()).toBe(
      '2026-07-15T04:00:00.000Z',
    )
  })

  it('o instante de agora cai dentro do dia de hoje — a invariante que importa', () => {
    for (const timeZone of [SP, 'UTC', 'America/New_York', 'Asia/Tokyo', 'America/Rio_Branco']) {
      const agora = new Date()
      const { from, to } = zonedDayRange(todayIn(timeZone, agora), timeZone)

      expect(agora.getTime()).toBeGreaterThanOrEqual(from.getTime())
      expect(agora.getTime()).toBeLessThanOrEqual(to.getTime())
    }
  })
})
