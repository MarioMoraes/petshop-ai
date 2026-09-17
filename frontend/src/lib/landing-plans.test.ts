import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLAN_CATALOG,
  PLAN_FEATURES,
  PLAN_ORDER,
  PlanFeatureSchema,
  PlanSchema,
  planIncludes,
  type PlanFeature,
} from '@petshop/shared-types'
import { describe, expect, it } from 'vitest'

/**
 * A guarda da landing page.
 *
 * `frontend/landing-page` é HTML estático e não importa o catálogo de planos, então nada
 * a impede de prometer uma divisão que o produto não segue — foi assim até 2026-09-17.
 * Este teste lê o HTML e compara com `PLAN_CATALOG`: preço, teto de usuários, destaques
 * de cada cartão e as marcas da tabela comparativa.
 *
 * Os cartões são achados por `data-plan` e as linhas da tabela por `data-feature`. Se ele
 * falhar, a pergunta é qual dos dois lados está certo — e o outro muda na mesma mudança.
 */

const html = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../landing-page/index.html'),
  'utf8',
)

const text = (fragment: string) =>
  fragment
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

function cards() {
  return [...html.matchAll(/<article[^>]*data-plan="([A-Z_]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(
    ([, plan, body]) => ({ plan: PlanSchema.parse(plan), body: body! }),
  )
}

/** As células de plano de uma linha da tabela, na ordem Starter, Pro, Enterprise. */
function planCells(row: string) {
  return [...row.matchAll(/<td class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, cls, body]) => ({
    included: /\byes\b/.test(cls!),
    text: text(body!),
  }))
}

describe('landing page × catálogo de planos', () => {
  it('tem um cartão por plano, na ordem do catálogo', () => {
    expect(cards().map((card) => card.plan)).toEqual([...PLAN_ORDER])
  })

  it('cada cartão mostra o preço, o título e os destaques do catálogo', () => {
    for (const { plan, body } of cards()) {
      const definition = PLAN_CATALOG[plan]
      const price = text(body.match(/<div class="price">([\s\S]*?)<\/div>/)![1]!)
      const expected =
        definition.priceCents === null ? 'Sob consulta' : `R$${definition.priceCents / 100}/mês`
      expect(price.replace(/\s/g, ''), plan).toBe(expected.replace(/\s/g, ''))

      expect(text(body.match(/<p class="plan-inc">([\s\S]*?)<\/p>/)![1]!), plan).toBe(
        definition.includesLead,
      )
      const items = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, li]) => text(li!))
      expect(items, plan).toEqual(definition.includes)
    }
  })

  it('a linha de usuários da tabela bate com o teto de cada plano', () => {
    const row = html.match(/<tr data-seats>([\s\S]*?)<\/tr>/)![1]!
    const seats = PLAN_ORDER.map((plan) => PLAN_CATALOG[plan].seats)
    expect(planCells(row).map((cell) => cell.text)).toEqual(
      seats.map((limit) => (limit === null ? 'Ilimitados' : String(limit))),
    )
  })

  it('as marcas da tabela seguem o plano mínimo de cada recurso', () => {
    const covered = new Set<PlanFeature>()

    for (const [, attr, row] of html.matchAll(/<tr data-feature="([A-Z_ ]+)">([\s\S]*?)<\/tr>/g)) {
      const features = attr!.split(' ').map((feature) => PlanFeatureSchema.parse(feature))
      const cells = planCells(row!)
      expect(cells, attr).toHaveLength(PLAN_ORDER.length)

      for (const feature of features) {
        covered.add(feature)
        PLAN_ORDER.forEach((plan, i) => {
          expect(cells[i]!.included, `${feature} no ${plan}`).toBe(planIncludes(plan, feature))
        })
      }
    }

    // Recurso novo no catálogo sem linha na tabela é recurso que a landing não vende.
    expect([...covered].sort()).toEqual([...PLAN_FEATURES].sort())
  })
})
