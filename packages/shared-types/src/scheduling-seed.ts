import type { ServiceCategory } from './scheduling.js'

/**
 * Serviços-modelo semeados no provisionamento (AC-01 de MOD-IDENT-01).
 *
 * Existem para que o tenant **nasça com catálogo**. Um petshop que termina o
 * onboarding e encontra a agenda vazia tem de inventar do zero o que já é igual em
 * toda a categoria — e, pior, a fatia 2 não teria o que agendar nem em teste manual.
 *
 * Os preços são **referência de mercado, não sugestão comercial**: entram como ponto
 * de partida editável, e a tela de serviços marca quem ainda não foi revisado. Errar
 * para menos é deliberado — é menos constrangedor descobrir que se está cobrando
 * pouco do que emitir uma cobrança alta por engano.
 *
 * As durações respeitam a grade de 15 minutos e crescem com o porte, que é a decisão
 * do §11 Q1: duração é tabela por porte, não multiplicador sobre uma base.
 */

export interface SeedServicePricing {
  /** Chave do porte no catálogo global (`sizes.key`), não o UUID. */
  sizeKey: 'SMALL' | 'MEDIUM' | 'LARGE' | 'GIANT'
  priceCents: number
  durationMin: number
}

export interface SeedService {
  name: string
  category: ServiceCategory
  baseDurationMin: number
  requiresVet: boolean
  description: string
  pricing: SeedServicePricing[]
}

export const SEED_SERVICES: readonly SeedService[] = [
  {
    name: 'Banho',
    category: 'BATH',
    baseDurationMin: 60,
    requiresVet: false,
    description: 'Banho com secagem, escovação e perfume.',
    pricing: [
      { sizeKey: 'SMALL', priceCents: 5000, durationMin: 45 },
      { sizeKey: 'MEDIUM', priceCents: 7000, durationMin: 60 },
      { sizeKey: 'LARGE', priceCents: 9000, durationMin: 90 },
      { sizeKey: 'GIANT', priceCents: 12000, durationMin: 120 },
    ],
  },
  {
    name: 'Banho e Tosa',
    category: 'GROOMING',
    baseDurationMin: 120,
    requiresVet: false,
    description: 'Banho completo com tosa na máquina ou na tesoura.',
    pricing: [
      { sizeKey: 'SMALL', priceCents: 9000, durationMin: 90 },
      { sizeKey: 'MEDIUM', priceCents: 12000, durationMin: 120 },
      { sizeKey: 'LARGE', priceCents: 15000, durationMin: 150 },
      { sizeKey: 'GIANT', priceCents: 19000, durationMin: 195 },
    ],
  },
  {
    name: 'Tosa Higiênica',
    category: 'GROOMING',
    baseDurationMin: 45,
    requiresVet: false,
    description: 'Aparo das patas, barriga e região íntima, sem banho.',
    pricing: [
      { sizeKey: 'SMALL', priceCents: 3500, durationMin: 30 },
      { sizeKey: 'MEDIUM', priceCents: 4500, durationMin: 45 },
      { sizeKey: 'LARGE', priceCents: 5500, durationMin: 45 },
      { sizeKey: 'GIANT', priceCents: 7000, durationMin: 60 },
    ],
  },
  {
    name: 'Corte de Unhas',
    category: 'OTHER',
    baseDurationMin: 15,
    requiresVet: false,
    description: 'Corte e lixamento das unhas.',
    pricing: [
      { sizeKey: 'SMALL', priceCents: 2000, durationMin: 15 },
      { sizeKey: 'MEDIUM', priceCents: 2000, durationMin: 15 },
      { sizeKey: 'LARGE', priceCents: 2500, durationMin: 15 },
      { sizeKey: 'GIANT', priceCents: 3000, durationMin: 30 },
    ],
  },
  {
    name: 'Consulta Veterinária',
    category: 'VET',
    baseDurationMin: 30,
    requiresVet: true,
    description: 'Avaliação clínica com veterinário.',
    // Consulta não varia com o porte: o que se cobra é o tempo do veterinário.
    pricing: [
      { sizeKey: 'SMALL', priceCents: 12000, durationMin: 30 },
      { sizeKey: 'MEDIUM', priceCents: 12000, durationMin: 30 },
      { sizeKey: 'LARGE', priceCents: 12000, durationMin: 30 },
      { sizeKey: 'GIANT', priceCents: 12000, durationMin: 30 },
    ],
  },
]
