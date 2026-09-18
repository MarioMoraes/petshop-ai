import { describe, expect, it } from 'vitest'
import {
  CoerceError,
  toAgeMonths,
  toBool,
  toDate,
  toDecimal,
  toEmail,
  toEnum,
  toList,
  toPhone,
  toTimeOfDay,
} from './coerce.js'

/**
 * Os conversores de célula. Testes puros.
 *
 * A regra que atravessa o arquivo é a que mais se testa aqui: **vazio e inválido são
 * coisas diferentes**. O primeiro devolve `undefined`; o segundo levanta.
 */

describe('vazio não é inválido', () => {
  it('célula em branco vira `undefined` em todos os conversores', () => {
    expect(toDate('')).toBeUndefined()
    expect(toDecimal('  ')).toBeUndefined()
    expect(toBool('')).toBeUndefined()
    expect(toAgeMonths('')).toBeUndefined()
    expect(toTimeOfDay('')).toBeUndefined()
    expect(toList('')).toBeUndefined()
  })
})

describe('toDate', () => {
  it('lê os formatos que sistema antigo exporta', () => {
    expect(toDate('31/12/2026')).toBe('2026-12-31')
    expect(toDate('31-12-2026')).toBe('2026-12-31')
    expect(toDate('2026-12-31')).toBe('2026-12-31')
    expect(toDate('31/12/2026 14:30:00')).toBe('2026-12-31')
  })

  it('ano de dois dígitos usa corte móvel, e não o do POSIX', () => {
    // Com o corte fixo em 69, "45" viraria 2045 — um pet que nasce no futuro.
    expect(toDate('10/07/45', 2026)).toBe('1945-07-10')
    expect(toDate('10/07/21', 2026)).toBe('2021-07-10')
  })

  it('recusa data que não existe, em vez de andar para o mês seguinte', () => {
    expect(() => toDate('31/02/2026')).toThrow(CoerceError)
  })

  it('recusa o que não é data', () => {
    expect(() => toDate('a combinar')).toThrow(CoerceError)
  })
})

describe('toTimeOfDay', () => {
  it('lê hora separada, compacta, só a hora e a data com hora junto', () => {
    expect(toTimeOfDay('14:30')).toBe('14:30')
    expect(toTimeOfDay('14h30')).toBe('14:30')
    expect(toTimeOfDay('1430')).toBe('14:30')
    expect(toTimeOfDay('9')).toBe('09:00')
    expect(toTimeOfDay('05/10/2026 14:30')).toBe('14:30')
  })

  it('recusa hora que não existe', () => {
    expect(() => toTimeOfDay('25:00')).toThrow(CoerceError)
    expect(() => toTimeOfDay('manhã')).toThrow(CoerceError)
  })
})

describe('toDecimal — o peso do pet', () => {
  it('lê vírgula, ponto e a unidade colada', () => {
    expect(toDecimal('12,5')).toBe(12.5)
    expect(toDecimal('12.5')).toBe(12.5)
    expect(toDecimal('12,5 kg')).toBe(12.5)
    expect(toDecimal('32')).toBe(32)
  })

  it('recusa o texto que viraria zero em silêncio', () => {
    // "a pesar" virando 0 poria o pet no porte errado, e o porte decide o preço.
    expect(() => toDecimal('a pesar')).toThrow(CoerceError)
  })
})

describe('toAgeMonths', () => {
  it('número seco é ANO, que é o que a coluna "Idade" quer dizer num petshop', () => {
    expect(toAgeMonths('4')).toBe(48)
  })

  it('a unidade explícita manda', () => {
    expect(toAgeMonths('8 meses')).toBe(8)
    expect(toAgeMonths('3 anos')).toBe(36)
    expect(toAgeMonths('1 ano e 6 meses')).toBe(18)
    expect(toAgeMonths('2a 3m')).toBe(27)
  })

  it('recusa idade fora do possível e texto', () => {
    expect(() => toAgeMonths('40 anos')).toThrow(CoerceError)
    expect(() => toAgeMonths('filhote')).toThrow(CoerceError)
  })
})

describe('toBool', () => {
  it('lê o que cada sistema escreve para sim e não', () => {
    for (const sim of ['S', 'Sim', '1', 'X', 'true', 'V']) expect(toBool(sim)).toBe(true)
    for (const nao of ['N', 'Não', '0', 'false']) expect(toBool(nao)).toBe(false)
  })

  it('recusa o que não é sim nem não, em vez de chutar', () => {
    expect(() => toBool('talvez')).toThrow(CoerceError)
  })
})

describe('toEnum', () => {
  const SEXO = { MALE: ['m', 'macho'], FEMALE: ['f', 'femea'] } as const

  it('casa pelo valor do domínio e pelos sinônimos, sem acento e sem caixa', () => {
    expect(toEnum('MALE', SEXO)).toBe('MALE')
    expect(toEnum('Fêmea', SEXO)).toBe('FEMALE')
  })

  it('valor desconhecido levanta com a lista do que é aceito — nunca escolhe o primeiro', () => {
    expect(() => toEnum('Indefinido', SEXO)).toThrow(/aceitos: MALE, FEMALE/)
  })
})

describe('toList', () => {
  it('parte a célula de vários valores pelos separadores que o legado usa', () => {
    expect(toList('Banho/Tosa higiênica')).toEqual(['Banho', 'Tosa higiênica'])
    expect(toList('Banho, Tosa')).toEqual(['Banho', 'Tosa'])
    expect(toList('Banho + Tosa')).toEqual(['Banho', 'Tosa'])
  })

  it('descarta os pedaços vazios de um separador solto no fim', () => {
    expect(toList('Banho;')).toEqual(['Banho'])
  })
})

describe('toPhone e toEmail', () => {
  it('telefone volta só com os dígitos — quem normaliza para E.164 é o schema do módulo', () => {
    expect(toPhone('(11) 98888-7777')).toBe('11988887777')
  })

  it('marcador de "não tem" vira ausência, e não um valor que reprova a linha inteira', () => {
    expect(toPhone('( )')).toBeUndefined()
    expect(toEmail('não tem')).toBeUndefined()
    expect(toEmail('ANA@EXEMPLO.COM')).toBe('ana@exemplo.com')
  })
})
