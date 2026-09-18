import { getMaintenancePrisma } from '@petshop/db'
import {
  PLAN_CATALOG,
  PLAN_ORDER,
  type Plan,
  type PlanPriceAdminRow,
  type UpdatePlanPriceInput,
} from '@petshop/shared-types'
import { recordPlatformAudit } from '../../shared/audit.js'
import { defaultPlanPrices, invalidatePlanPrices } from '../../shared/plan-prices.js'
import { invalidState, notFound } from './errors.js'

/**
 * A tabela de preços, mantida pelo console (camada comercial).
 *
 * **O que esta rota muda é o preço de quem chega, e nunca o de quem já está.** Quem assina
 * tem o valor congelado em `tenant_subscriptions.price_cents` e na assinatura do Asaas;
 * nada aqui os toca. É uma escolha, não um esquecimento: reajustar a base é uma operação
 * com aviso prévio ao cliente, e ela não cabe atrás de um botão de "Salvar".
 *
 * **O Enterprise não entra.** Ele é sob consulta — `priceCents` nulo no catálogo —, e um
 * número aqui viraria uma tabela que a landing não mostra e que ninguém cobra.
 */

export interface PriceActor {
  userId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

/** Os planos cujo preço é de tabela. O Enterprise fica de fora por não ter preço. */
export function pricedPlans(): Plan[] {
  return PLAN_ORDER.filter((plan) => PLAN_CATALOG[plan].priceCents !== null)
}

export async function listPlanPrices(): Promise<{ items: PlanPriceAdminRow[] }> {
  const padrao = defaultPlanPrices()
  const gravados = new Map(
    (await getMaintenancePrisma().planPrice.findMany()).map((row) => [row.plan as Plan, row]),
  )

  const items = PLAN_ORDER.map((plan): PlanPriceAdminRow => {
    const row = PLAN_CATALOG[plan].priceCents === null ? undefined : gravados.get(plan)
    return {
      plan,
      name: PLAN_CATALOG[plan].name,
      monthlyCents: row?.priceCents ?? padrao[plan].monthlyCents,
      yearlyCents: row?.priceYearlyCents ?? padrao[plan].yearlyCents,
      defaultMonthlyCents: padrao[plan].monthlyCents,
      defaultYearlyCents: padrao[plan].yearlyCents,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    }
  })

  return { items }
}

export async function updatePlanPrice(
  actor: PriceActor,
  plan: Plan,
  input: UpdatePlanPriceInput,
): Promise<PlanPriceAdminRow> {
  if (PLAN_CATALOG[plan].priceCents === null) {
    throw invalidState(
      `O plano ${PLAN_CATALOG[plan].name} é sob consulta: o preço dele é combinado com o cliente, e não de tabela.`,
    )
  }
  if (input.yearlyCents >= input.monthlyCents * 12) {
    throw invalidState(
      'O preço anual precisa sair mais barato que doze mensalidades — senão não há por que contratá-lo.',
    )
  }

  const prisma = getMaintenancePrisma()
  const antes = await prisma.planPrice.findUnique({ where: { plan } })

  const linha = await prisma.planPrice.upsert({
    where: { plan },
    create: {
      plan,
      priceCents: input.monthlyCents,
      priceYearlyCents: input.yearlyCents,
      updatedBy: actor.userId,
    },
    update: {
      priceCents: input.monthlyCents,
      priceYearlyCents: input.yearlyCents,
      updatedBy: actor.userId,
    },
  })

  await invalidatePlanPrices()

  const padrao = defaultPlanPrices()
  await recordPlatformAudit({
    action: 'platform.plan_price_changed',
    entity: 'plan_price',
    entityId: plan,
    actorUserId: actor.userId,
    // Sem linha anterior, o "antes" é o padrão do código — que é o que estava valendo.
    before: {
      monthlyCents: antes?.priceCents ?? padrao[plan].monthlyCents,
      yearlyCents: antes?.priceYearlyCents ?? padrao[plan].yearlyCents,
    },
    after: {
      monthlyCents: linha.priceCents,
      yearlyCents: linha.priceYearlyCents,
      reason: input.reason,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  return {
    plan,
    name: PLAN_CATALOG[plan].name,
    monthlyCents: linha.priceCents,
    yearlyCents: linha.priceYearlyCents,
    defaultMonthlyCents: padrao[plan].monthlyCents,
    defaultYearlyCents: padrao[plan].yearlyCents,
    updatedAt: linha.updatedAt.toISOString(),
  }
}

/** Voltar ao padrão do código: apaga a linha, e não grava o padrão como escolha. */
export async function resetPlanPrice(actor: PriceActor, plan: Plan): Promise<PlanPriceAdminRow> {
  const prisma = getMaintenancePrisma()
  const antes = await prisma.planPrice.findUnique({ where: { plan } })
  if (!antes) throw notFound('Este plano já está no preço padrão')

  await prisma.planPrice.delete({ where: { plan } })
  await invalidatePlanPrices()

  const padrao = defaultPlanPrices()
  await recordPlatformAudit({
    action: 'platform.plan_price_reset',
    entity: 'plan_price',
    entityId: plan,
    actorUserId: actor.userId,
    before: { monthlyCents: antes.priceCents, yearlyCents: antes.priceYearlyCents },
    after: {
      monthlyCents: padrao[plan].monthlyCents,
      yearlyCents: padrao[plan].yearlyCents,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  return {
    plan,
    name: PLAN_CATALOG[plan].name,
    monthlyCents: padrao[plan].monthlyCents,
    yearlyCents: padrao[plan].yearlyCents,
    defaultMonthlyCents: padrao[plan].monthlyCents,
    defaultYearlyCents: padrao[plan].yearlyCents,
    updatedAt: null,
  }
}
