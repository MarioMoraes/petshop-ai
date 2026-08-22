import { describe, expect, it } from 'vitest'
import {
  formatPhoneBR,
  isValidCEP,
  isValidCNPJ,
  isValidCPF,
  maskCPF,
  maskEmail,
  maskPhone,
  normalizePhoneBR,
} from './br-documents.js'

describe('CPF', () => {
  it('aceita CPF com dígitos verificadores corretos, com e sem máscara', () => {
    expect(isValidCPF('529.982.247-25')).toBe(true)
    expect(isValidCPF('52998224725')).toBe(true)
  })

  it('rejeita dígito verificador inválido (AC-02 de MOD-TUTOR-01)', () => {
    expect(isValidCPF('52998224726')).toBe(false)
  })

  it('rejeita sequência repetida, que passa no módulo 11 mas não existe', () => {
    expect(isValidCPF('11111111111')).toBe(false)
    expect(isValidCPF('00000000000')).toBe(false)
  })

  it('rejeita comprimento errado', () => {
    expect(isValidCPF('5299822472')).toBe(false)
    expect(isValidCPF('')).toBe(false)
  })
})

describe('CNPJ', () => {
  it('aceita CNPJ válido', () => {
    expect(isValidCNPJ('11.222.333/0001-81')).toBe(true)
  })

  it('rejeita dígito verificador inválido e sequência repetida', () => {
    expect(isValidCNPJ('11222333000182')).toBe(false)
    expect(isValidCNPJ('11111111111111')).toBe(false)
  })
})

describe('normalizePhoneBR — RN-04', () => {
  it('normaliza celular com máscara para E.164', () => {
    expect(normalizePhoneBR('(11) 98765-4321')).toBe('+5511987654321')
  })

  it('aceita o número já com 55 e com +', () => {
    expect(normalizePhoneBR('+55 11 98765-4321')).toBe('+5511987654321')
    expect(normalizePhoneBR('5511987654321')).toBe('+5511987654321')
  })

  it('acrescenta o nono dígito em celular antigo de 8 dígitos', () => {
    expect(normalizePhoneBR('1187654321')).toBe('+5511987654321')
  })

  it('preserva telefone fixo de 8 dígitos, que não recebe o 9', () => {
    expect(normalizePhoneBR('1132654321')).toBe('+551132654321')
  })

  it('rejeita DDD inexistente', () => {
    expect(() => normalizePhoneBR('(10) 98765-4321')).toThrow('DDD inválido')
  })

  it('rejeita comprimento fora de 10–11 dígitos', () => {
    expect(() => normalizePhoneBR('987654321')).toThrow('Telefone inválido')
    expect(() => normalizePhoneBR('11987654321987')).toThrow()
  })

  it('rejeita 9 dígitos com prefixo de fixo', () => {
    expect(() => normalizePhoneBR('11332654321')).toThrow('Telefone inválido')
  })
})

describe('máscaras do PRD §5', () => {
  it('mascara CPF como ***.***.789-01', () => {
    expect(maskCPF('12345678901')).toBe('***.***.789-01')
  })

  it('mascara telefone como (11) *****-4321', () => {
    expect(maskPhone('+5511987654321')).toBe('(11) *****-4321')
  })

  it('mascara e-mail preservando o domínio', () => {
    expect(maskEmail('maria@exemplo.com')).toBe('ma****@exemplo.com')
  })

  it('formata telefone E.164 de volta para leitura humana', () => {
    expect(formatPhoneBR('+5511987654321')).toBe('(11) 98765-4321')
    expect(formatPhoneBR('+551132654321')).toBe('(11) 3265-4321')
  })

  it('valida CEP com 8 dígitos', () => {
    expect(isValidCEP('01310-100')).toBe(true)
    expect(isValidCEP('0131010')).toBe(false)
  })
})
