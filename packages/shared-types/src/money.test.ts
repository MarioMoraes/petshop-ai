import { describe, expect, it } from 'vitest'
import { formatBRL, formatCentsInput, parseBRLToCents, percentOfCents } from './money.js'

/**
 * O `Intl` separa o símbolo do número com **espaço não separável** (U+00A0), não com
 * espaço comum. Escrevê-lo literalmente na asserção deixaria um caractere invisível no
 * fonte — que é exatamente o que o `no-irregular-whitespace` do lint existe para pegar.
 */
const NBSP = '\u00a0'

describe('formatBRL', () => {
  it('formata centavos no padrão brasileiro', () => {
    expect(formatBRL(1250)).toBe(`R$${NBSP}12,50`)
    expect(formatBRL(0)).toBe(`R$${NBSP}0,00`)
    expect(formatBRL(123456789)).toBe(`R$${NBSP}1.234.567,89`)
  })

  it('mostra o sinal da dívida', () => {
    expect(formatBRL(-15000)).toBe(`-R$${NBSP}150,00`)
  })

  it('aceita BigInt, que é como o Prisma devolve as colunas de dinheiro', () => {
    expect(formatBRL(12000n)).toBe(`R$${NBSP}120,00`)
  })
})

describe('formatCentsInput', () => {
  it('serve o número cru, sem símbolo, para dentro do campo', () => {
    expect(formatCentsInput(1250)).toBe('12,50')
    expect(formatCentsInput(0)).toBe('0,00')
    expect(formatCentsInput(5)).toBe('0,05')
  })
})

describe('parseBRLToCents', () => {
  it('aceita o que o balcão realmente digita', () => {
    expect(parseBRLToCents('R$ 12,50')).toBe(1250)
    expect(parseBRLToCents('12,50')).toBe(1250)
    expect(parseBRLToCents('1.234,56')).toBe(123456)
    expect(parseBRLToCents('1234.56')).toBe(123456)
    expect(parseBRLToCents('89')).toBe(8900)
  })

  it('arredonda half-up: o meio centavo vai para quem paga', () => {
    expect(parseBRLToCents('12,345')).toBe(1235)
    expect(parseBRLToCents('12,344')).toBe(1234)
  })

  it('devolve null quando não sobra número — a rota decide se isso é 422', () => {
    expect(parseBRLToCents('')).toBeNull()
    expect(parseBRLToCents('R$')).toBeNull()
    expect(parseBRLToCents('abc')).toBeNull()
  })

  it('faz o round-trip com formatCentsInput', () => {
    for (const cents of [0, 5, 99, 1250, 123456, 100_000_000]) {
      expect(parseBRLToCents(formatCentsInput(cents))).toBe(cents)
    }
  })
})

describe('percentOfCents', () => {
  it('aplica o percentual com arredondamento half-up', () => {
    expect(percentOfCents(10000, 50)).toBe(5000)
    expect(percentOfCents(10000, 0)).toBe(0)
    // 3333,5 centavos — meio centavo arredonda para cima.
    expect(percentOfCents(6667, 50)).toBe(3334)
  })
})
