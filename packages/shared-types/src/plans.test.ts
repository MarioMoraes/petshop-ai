import { describe, expect, it } from 'vitest'
import {
  ANNUAL_DISCOUNT_PERCENT,
  BILLING_CYCLES,
  PLAN_CATALOG,
  PLAN_FEATURES,
  PLAN_ORDER,
  annualSavingsCents,
  minimumPlanFor,
  parsePlanParam,
  planFeatures,
  planIncludes,
  planPriceCents,
  yearlyPriceOf,
} from './plans.js'

describe('catálogo de planos', () => {
  it('todo recurso é liberado por exatamente um plano', () => {
    for (const feature of PLAN_FEATURES) {
      const owners = PLAN_ORDER.filter((plan) => PLAN_CATALOG[plan].adds.includes(feature))
      expect(owners, feature).toHaveLength(1)
    }
  })

  it('cada plano contém tudo o que o anterior libera', () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const previous = planFeatures(PLAN_ORDER[i - 1]!)
      const current = planFeatures(PLAN_ORDER[i]!)
      expect(current).toEqual(expect.arrayContaining(previous))
    }
  })

  it('o teto de usuários e a cota de fotos só crescem, e o último é ilimitado', () => {
    const grows = (values: Array<number | null>) =>
      values.every(
        (value, i) =>
          i === 0 || value === null || (values[i - 1] !== null && value > values[i - 1]!),
      )
    expect(grows(PLAN_ORDER.map((plan) => PLAN_CATALOG[plan].seats))).toBe(true)
    expect(grows(PLAN_ORDER.map((plan) => PLAN_CATALOG[plan].photoQuota))).toBe(true)
    expect(PLAN_CATALOG.ENTERPRISE.seats).toBeNull()
  })

  it('a divisão aceita em 2026-09-16', () => {
    expect(planIncludes('STARTER', 'WHATSAPP')).toBe(false)
    expect(minimumPlanFor('AI_AGENT')).toBe('PRO')
    expect(minimumPlanFor('PORTAL')).toBe('PRO')
    expect(minimumPlanFor('AI_PERSONA')).toBe('ENTERPRISE')
    expect(planIncludes('ENTERPRISE', 'TAXI')).toBe(true)
  })

  it('o preço anual de cada plano é o desconto anunciado sobre doze mensalidades', () => {
    for (const plan of PLAN_ORDER) {
      const { priceCents, priceYearlyCents } = PLAN_CATALOG[plan]
      if (priceCents === null) {
        // Sob consulta é sob consulta nos dois ciclos: um preço anual aqui seria uma
        // tabela que a landing não mostra.
        expect(priceYearlyCents, plan).toBeNull()
        continue
      }
      expect(priceYearlyCents, plan).toBe(yearlyPriceOf(priceCents))
      expect(annualSavingsCents(plan), plan).toBe(priceCents * 12 - priceYearlyCents!)
    }
  })

  it('o anual sai mais barato que doze mensalidades, e o desconto é o anunciado', () => {
    expect(yearlyPriceOf(14_900)).toBe(143_000)
    expect(yearlyPriceOf(29_900)).toBe(287_000)
    // O arredondamento para real inteiro nunca cobra mais do que o desconto promete.
    for (const plan of PLAN_ORDER) {
      const mensal = PLAN_CATALOG[plan].priceCents
      if (mensal === null) continue
      const desconto = (annualSavingsCents(plan)! * 100) / (mensal * 12)
      expect(desconto, plan).toBeGreaterThanOrEqual(ANNUAL_DISCOUNT_PERCENT)
      expect(desconto, plan).toBeLessThan(ANNUAL_DISCOUNT_PERCENT + 1)
    }
  })

  it('o preço de uma cobrança sai do par plano × ciclo', () => {
    expect(planPriceCents('STARTER', 'MONTHLY')).toBe(14_900)
    expect(planPriceCents('STARTER', 'YEARLY')).toBe(143_000)
    expect(BILLING_CYCLES.map((cycle) => planPriceCents('ENTERPRISE', cycle))).toEqual([null, null])
  })

  it('lê o ?plan= da landing sem confiar nele', () => {
    expect(parsePlanParam('pro')).toBe('PRO')
    expect(parsePlanParam(' Enterprise ')).toBe('ENTERPRISE')
    expect(parsePlanParam('gold')).toBeNull()
    expect(parsePlanParam(['pro'])).toBeNull()
    expect(parsePlanParam(undefined)).toBeNull()
  })
})
