import { describe, expect, it } from 'vitest'
import { localParts, matches, parseCron } from './cron.js'

const BRT = 'America/Sao_Paulo'

function hits(expression: string, iso: string, timeZone = BRT): boolean {
  return matches(parseCron(expression), new Date(iso), timeZone)
}

describe('parseCron', () => {
  it('recusa expressão que não tenha cinco campos', () => {
    expect(() => parseCron('0 3 * *')).toThrow(/5 campos/)
    expect(() => parseCron('0 3 * * * *')).toThrow(/5 campos/)
  })

  it('recusa valor fora da faixa do campo', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/minuto/)
    expect(() => parseCron('* 24 * * *')).toThrow(/hora/)
    expect(() => parseCron('* * * 13 *')).toThrow(/mês/)
  })

  it('expande passo, faixa e lista', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45])
    expect([...parseCron('0 1-3 * * *').hour]).toEqual([1, 2, 3])
    expect([...parseCron('0 3,15 * * *').hour]).toEqual([3, 15])
  })

  it('`*` cobre a faixa inteira do campo', () => {
    expect(parseCron('* * * * *').minute.size).toBe(60)
    expect(parseCron('* * * * *').dayOfWeek.size).toBe(7)
  })
})

describe('matches — grade da casa', () => {
  it('*/15 casa nos quatro minutos e em nenhum outro', () => {
    expect(hits('*/15 * * * *', '2026-08-26T12:00:00-03:00')).toBe(true)
    expect(hits('*/15 * * * *', '2026-08-26T12:15:00-03:00')).toBe(true)
    expect(hits('*/15 * * * *', '2026-08-26T12:45:00-03:00')).toBe(true)
    expect(hits('*/15 * * * *', '2026-08-26T12:07:00-03:00')).toBe(false)
  })

  it('o job das 3h da manhã casa às 3h **de Brasília**, não de UTC', () => {
    // 03:00 BRT é 06:00 UTC. Uma grade avaliada em UTC rodaria o job de madrugada
    // no meio da manhã do petshop — em cima do movimento que ele existe para evitar.
    expect(hits('0 3 * * *', '2026-08-26T03:00:00-03:00')).toBe(true)
    expect(hits('0 3 * * *', '2026-08-26T03:00:00Z')).toBe(false)
    expect(hits('0 3 * * *', '2026-08-26T03:00:00-03:00', 'UTC')).toBe(false)
  })

  it('domingo é 0, e a semana começa nele', () => {
    // 2026-08-30 é domingo; 2026-08-31 é segunda.
    expect(hits('30 3 * * 0', '2026-08-30T03:30:00-03:00')).toBe(true)
    expect(hits('30 3 * * 0', '2026-08-31T03:30:00-03:00')).toBe(false)
  })

  it('meia-noite casa com a hora 0, não com 24', () => {
    expect(hits('0 0 * * *', '2026-08-26T00:00:00-03:00')).toBe(true)
  })
})

describe('matches — a regra dos dois campos de dia', () => {
  it('com os dois restritos, vale a união (é o cron do Vixie)', () => {
    // Dia 1 do mês OU segunda-feira. 2026-09-01 é uma terça — casa pelo dia do mês.
    expect(hits('0 0 1 * 1', '2026-09-01T00:00:00-03:00')).toBe(true)
    // 2026-08-31 é segunda — casa pelo dia da semana.
    expect(hits('0 0 1 * 1', '2026-08-31T00:00:00-03:00')).toBe(true)
    // 2026-09-02 é quarta e não é dia 1 — não casa.
    expect(hits('0 0 1 * 1', '2026-09-02T00:00:00-03:00')).toBe(false)
  })

  it('com só um restrito, vale ele sozinho', () => {
    expect(hits('0 0 15 * *', '2026-08-15T00:00:00-03:00')).toBe(true)
    expect(hits('0 0 15 * *', '2026-08-16T00:00:00-03:00')).toBe(false)
  })
})

describe('localParts', () => {
  it('lê o instante no fuso pedido, não no do servidor', () => {
    const meiaNoiteEmBrasilia = new Date('2026-08-26T03:00:00Z')

    expect(localParts(meiaNoiteEmBrasilia, BRT)).toMatchObject({
      hour: 0,
      minute: 0,
      dayOfMonth: 26,
      month: 8,
      // 26/08/2026 é uma quarta-feira.
      dayOfWeek: 3,
    })
    expect(localParts(meiaNoiteEmBrasilia, 'UTC').hour).toBe(3)
  })
})
