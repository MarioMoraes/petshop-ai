import { describe, expect, it } from 'vitest'
import {
  CreatePetSchema,
  UpdatePetSchema,
  birthDateFromEstimatedAge,
  formatAgeLabel,
  maskMicrochip,
  monthsBetween,
  normalizeBreedLabel,
} from './pet.js'

const TUTOR_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_TUTOR_ID = '22222222-2222-4222-8222-222222222222'
const SPECIES_ID = '33333333-3333-4333-8333-333333333333'
const SIZE_ID = '44444444-4444-4444-8444-444444444444'

const validPet = {
  name: 'Thor',
  speciesId: SPECIES_ID,
  sizeId: SIZE_ID,
  sex: 'MALE',
  birthDate: '2021-03-10',
  tutors: [{ tutorId: TUTOR_ID, role: 'PRIMARY' }],
}

describe('idade (MOD-PET-06)', () => {
  it('conta meses completos, sem arredondar para cima', () => {
    // Um dia antes do aniversário de mês ainda são 11 meses, não 12.
    expect(monthsBetween(new Date('2024-01-15'), new Date('2024-12-14'))).toBe(10)
    expect(monthsBetween(new Date('2024-01-15'), new Date('2025-01-15'))).toBe(12)
    expect(monthsBetween(new Date('2024-01-15'), new Date('2024-01-20'))).toBe(0)
  })

  it('nunca devolve idade negativa para data futura', () => {
    expect(monthsBetween(new Date('2026-01-01'), new Date('2025-01-01'))).toBe(0)
  })

  it('AC-03: idade estimada de 24 meses vira "≈ 2 anos"', () => {
    const reference = new Date('2026-08-22T12:00:00Z')
    const derived = birthDateFromEstimatedAge(24, reference)

    expect(derived).toBe('2024-08-22')
    const months = monthsBetween(new Date(derived), reference)
    expect(formatAgeLabel(months, 'ESTIMATED')).toBe('≈ 2 anos')
  })

  it('rotula com precisão exata, sem o marcador de estimativa', () => {
    expect(formatAgeLabel(0, 'EXACT')).toBe('menos de 1 mês')
    expect(formatAgeLabel(1, 'EXACT')).toBe('1 mês')
    expect(formatAgeLabel(18, 'EXACT')).toBe('18 meses')
    expect(formatAgeLabel(27, 'EXACT')).toBe('2 anos e 3 meses')
    expect(formatAgeLabel(13, 'ESTIMATED')).toBe('≈ 13 meses')
  })

  it('não rotula quando a idade é desconhecida', () => {
    expect(formatAgeLabel(null, 'UNKNOWN')).toBeNull()
    expect(formatAgeLabel(24, 'UNKNOWN')).toBeNull()
  })
})

describe('CreatePetSchema', () => {
  it('aceita o cadastro completo do AC-01', () => {
    const parsed = CreatePetSchema.parse({ ...validPet, weightKg: 32.4, neutered: true })
    expect(parsed.tutors[0]?.canAuthorizeProcedures).toBe(true)
  })

  it('exige data de nascimento ou idade estimada', () => {
    const result = CreatePetSchema.safeParse({ ...validPet, birthDate: undefined })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['birthDate'])
  })

  it('exige exatamente um responsável principal', () => {
    const twoPrimaries = CreatePetSchema.safeParse({
      ...validPet,
      tutors: [
        { tutorId: TUTOR_ID, role: 'PRIMARY' },
        { tutorId: OTHER_TUTOR_ID, role: 'PRIMARY' },
      ],
    })
    expect(twoPrimaries.success).toBe(false)

    const noPrimary = CreatePetSchema.safeParse({
      ...validPet,
      tutors: [{ tutorId: TUTOR_ID, role: 'SECONDARY' }],
    })
    expect(noPrimary.success).toBe(false)
  })

  it('rejeita o mesmo tutor vinculado duas vezes', () => {
    const result = CreatePetSchema.safeParse({
      ...validPet,
      tutors: [
        { tutorId: TUTOR_ID, role: 'PRIMARY' },
        { tutorId: TUTOR_ID, role: 'SECONDARY' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('normaliza o microchip e recusa quem não tem 15 dígitos', () => {
    const parsed = CreatePetSchema.parse({ ...validPet, microchip: '981-020-000-123456' })
    expect(parsed.microchip).toBe('981020000123456')

    expect(CreatePetSchema.safeParse({ ...validPet, microchip: '12345' }).success).toBe(false)
  })
})

describe('UpdatePetSchema', () => {
  it('distingue campo ausente de campo limpo com null', () => {
    const parsed = UpdatePetSchema.parse({ breedId: null })
    expect(parsed).toHaveProperty('breedId', null)
    expect(parsed.name).toBeUndefined()
  })

  it('não aceita DECEASED — o óbito tem fluxo próprio (MOD-PET-08)', () => {
    expect(UpdatePetSchema.safeParse({ status: 'DECEASED' }).success).toBe(false)
    expect(UpdatePetSchema.safeParse({ status: 'INACTIVE' }).success).toBe(true)
  })
})

describe('normalizeBreedLabel', () => {
  it('iguala variações de caixa, acento e espaço', () => {
    expect(normalizeBreedLabel('  Golden   Retriever ')).toBe('golden retriever')
    expect(normalizeBreedLabel('Pastor Alemão')).toBe(normalizeBreedLabel('pastor alemao'))
  })
})

describe('maskMicrochip', () => {
  it('preserva os quatro últimos dígitos, que é o que se confere no balcão', () => {
    expect(maskMicrochip('981020000123456')).toBe('***********3456')
  })
})
