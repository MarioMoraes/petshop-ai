import { describe, expect, it } from 'vitest'
import {
  CreateTagSchema,
  CreateTutorSchema,
  ListTutorsQuerySchema,
  MergeTutorSchema,
  UpdateTutorSchema,
} from './tutor.js'

const baseConsents = { whatsapp: true, email: true, terms: true }

describe('CreateTutorSchema', () => {
  it('normaliza telefone e CPF no parse (AC-01 de MOD-TUTOR-01)', () => {
    const parsed = CreateTutorSchema.parse({
      fullName: 'Maria Silva',
      phone: '(11) 98765-4321',
      cpf: '529.982.247-25',
      email: 'maria@exemplo.com',
      birthDate: '1988-04-12',
      consents: baseConsents,
    })

    expect(parsed.phone).toBe('+5511987654321')
    expect(parsed.cpf).toBe('52998224725')
    expect(parsed.personType).toBe('PF')
    expect(parsed.duplicateAcknowledged).toBe(false)
  })

  it('aceita PF sem CPF — cadastro de balcão (AC-03)', () => {
    const parsed = CreateTutorSchema.parse({
      fullName: 'Maria Silva',
      phone: '11987654321',
      consents: baseConsents,
    })
    expect(parsed.cpf).toBeUndefined()
  })

  it('rejeita CPF com dígito verificador inválido (AC-02)', () => {
    const result = CreateTutorSchema.safeParse({
      fullName: 'Maria Silva',
      phone: '11987654321',
      cpf: '11111111111',
      consents: baseConsents,
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('CPF inválido')
    expect(result.error?.issues[0]?.path).toEqual(['cpf'])
  })

  it('exige CNPJ e razão social quando PJ (AC-04)', () => {
    const result = CreateTutorSchema.safeParse({
      personType: 'PJ',
      fullName: 'Pet Ltda',
      phone: '11987654321',
      consents: baseConsents,
    })
    expect(result.success).toBe(false)
    const fields = result.error?.issues.map((issue) => issue.path.join('.'))
    expect(fields).toContain('cnpj')
    expect(fields).toContain('legalName')
  })

  it('exige o aceite dos termos', () => {
    const result = CreateTutorSchema.safeParse({
      fullName: 'Maria Silva',
      phone: '11987654321',
      consents: { whatsapp: true, email: false, terms: false },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Aceite dos termos é obrigatório')
  })

  it('exige telefone — é o canal primário (RN-03)', () => {
    const result = CreateTutorSchema.safeParse({ fullName: 'Maria Silva', consents: baseConsents })
    expect(result.success).toBe(false)
  })
})

describe('UpdateTutorSchema', () => {
  it('distingue campo ausente de campo limpo com null', () => {
    const parsed = UpdateTutorSchema.parse({ email: null })
    expect(parsed).toHaveProperty('email', null)
    expect(parsed).not.toHaveProperty('phone')
  })

  it('não permite transicionar para estado terminal pela edição', () => {
    expect(UpdateTutorSchema.safeParse({ status: 'MERGED' }).success).toBe(false)
    expect(UpdateTutorSchema.safeParse({ status: 'INACTIVE' }).success).toBe(true)
  })
})

describe('CreateTagSchema', () => {
  it('normaliza a chave para maiúsculas', () => {
    expect(CreateTagSchema.parse({ key: 'vip', label: 'VIP' }).key).toBe('VIP')
  })

  it('recusa chave reservada ao sistema (AC-02 de MOD-TUTOR-05)', () => {
    expect(CreateTagSchema.safeParse({ key: 'INATIVO', label: 'Inativo' }).success).toBe(false)
  })
})

describe('MergeTutorSchema', () => {
  it('exige a frase de confirmação', () => {
    const input = { sourceId: crypto.randomUUID(), confirmation: 'sim' }
    expect(MergeTutorSchema.safeParse(input).success).toBe(false)
  })
})

describe('ListTutorsQuerySchema', () => {
  it('aplica paginação padrão e coage os números da query string', () => {
    const parsed = ListTutorsQuerySchema.parse({ page: '2' })
    expect(parsed).toMatchObject({ page: 2, limit: 20 })
  })

  it('limita o tamanho da página', () => {
    expect(ListTutorsQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
  })
})
