import { describe, expect, it } from 'vitest'
import {
  PLAN_CATALOG,
  PLAN_FEATURES,
  PLAN_ORDER,
  minimumPlanFor,
  parsePlanParam,
  planFeatures,
  planIncludes,
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

  it('lê o ?plan= da landing sem confiar nele', () => {
    expect(parsePlanParam('pro')).toBe('PRO')
    expect(parsePlanParam(' Enterprise ')).toBe('ENTERPRISE')
    expect(parsePlanParam('gold')).toBeNull()
    expect(parsePlanParam(['pro'])).toBeNull()
    expect(parsePlanParam(undefined)).toBeNull()
  })
})
