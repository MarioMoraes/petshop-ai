import { getMaintenancePrisma } from '@petshop/db'
import {
  PLAN_CATALOG,
  PLAN_ORDER,
  type BillingCycle,
  type Plan,
  type PlanPriceRow,
} from '@petshop/shared-types'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from './redis.js'

/**
 * Quanto custa cada plano **agora**.
 *
 * Até 2026-09-18 a resposta era uma constante em `shared-types/plans.ts`, e mudar preço
 * era editar código e implantar. Agora a equipe da PetShop AI muda pelo console, e o que
 * ela grava vive em `plan_prices`.
 *
 * **O catálogo não saiu de cena — virou o padrão.** Linha ausente na tabela significa "usa
 * o do código", e é por isso que a tabela nasce vazia: uma instalação recém-subida já tem
 * preço, sem semente e sem ninguém precisar abrir o console. É também o que mantém de pé a
 * reserva da landing, que é HTML estático e precisa de um número no arquivo.
 *
 * **Quem já assina não lê daqui.** O preço contratado está em
 * `tenant_subscriptions.price_cents`, congelado na assinatura, e é ele que a tela do
 * estabelecimento mostra. Esta função responde a pergunta de quem está **começando** —
 * o checkout e a troca de plano —, e a landing, que vende para quem ainda não é cliente.
 *
 * **Sem tenant e sem RLS.** O preço é da instalação, como `platform_admins`. A leitura sai
 * de `getMaintenancePrisma` porque não há tenant a pôr no contexto, e a chave de cache é
 * única no Redis — não há uma por estabelecimento.
 */

export type PlanPriceTable = Record<
  Plan,
  { monthlyCents: number | null; yearlyCents: number | null }
>

/** O padrão do código, que vale enquanto ninguém tiver mexido no console. */
export function defaultPlanPrices(): PlanPriceTable {
  return Object.fromEntries(
    PLAN_ORDER.map((plan) => [
      plan,
      {
        monthlyCents: PLAN_CATALOG[plan].priceCents,
        yearlyCents: PLAN_CATALOG[plan].priceYearlyCents,
      },
    ]),
  ) as PlanPriceTable
}

export async function planPrices(): Promise<PlanPriceTable> {
  const cached = await cacheGet<PlanPriceTable>(CACHE_KEYS.planPrices)
  if (cached) return cached

  const table = defaultPlanPrices()
  for (const row of await getMaintenancePrisma().planPrice.findMany()) {
    // O Enterprise é sob consulta e não tem linha; se um dia tiver, ela é ignorada aqui
    // pelo mesmo motivo que o console não a oferece — preço dele não é de tabela.
    if (PLAN_CATALOG[row.plan as Plan].priceCents === null) continue
    table[row.plan as Plan] = {
      monthlyCents: row.priceCents,
      yearlyCents: row.priceYearlyCents,
    }
  }

  await cacheSet(CACHE_KEYS.planPrices, table, CACHE_TTL_SECONDS.planPrices)
  return table
}

/**
 * O valor de uma cobrança no par plano × ciclo. `null` é sob consulta.
 *
 * É o substituto de `planPriceCents` do catálogo em **todo caminho de cobrança** do
 * backend. Quem chamar o do catálogo ali estará cobrando o preço de antes do reajuste.
 */
export async function effectivePlanPrice(plan: Plan, cycle: BillingCycle): Promise<number | null> {
  const prices = (await planPrices())[plan]
  return cycle === 'YEARLY' ? prices.yearlyCents : prices.monthlyCents
}

/** O que a landing e o console leem, na ordem do catálogo. */
export async function planPriceRows(): Promise<PlanPriceRow[]> {
  const table = await planPrices()
  return PLAN_ORDER.map((plan) => ({ plan, ...table[plan] }))
}

/** A tabela nova vale na requisição seguinte, e não quando o cache expirar. */
export async function invalidatePlanPrices(): Promise<void> {
  await cacheDelete(CACHE_KEYS.planPrices)
}
