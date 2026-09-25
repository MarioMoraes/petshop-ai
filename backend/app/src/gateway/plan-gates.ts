import type { PlanFeature } from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { assertFeature } from '../shared/plan.js'

/**
 * Quais rotas da equipe dependem de plano — numa tabela só.
 *
 * A tabela é por **prefixo do padrão da rota** (`request.routeOptions.url`), e não por
 * handler, pela mesma razão que a separação entre público e autenticado é por escopo: o
 * esquecimento tem de aparecer na leitura. Uma rota nova debaixo de `/v1/taxi` nasce
 * bloqueada no Starter sem ninguém lembrar de nada; espalhada pelos handlers, a rota
 * nova nasceria liberada.
 *
 * Uma rota que casa com mais de um prefixo exige **todos**: `/v1/agent/stats` pede o
 * agente e o painel de qualidade.
 *
 * O que **não** está aqui, e por quê:
 *
 * - `/portal/v1` e `/public/v1/site` — quem chega é o cliente do petshop, que não tem
 *   nada a ver com o plano. Respondem 404, como um estabelecimento que não existe, e a
 *   checagem mora na resolução do slug (`auth/portal-session.ts`, `modules/site/resolve.ts`);
 * - as automações de cobrança e aniversário (`/v1/crm/automations/:key`) — a rota é a
 *   mesma dos lembretes, que são de todo plano; quem separa é a chave, em `crm/automations.ts`;
 * - a persona do agente — é um campo do `PATCH /v1/agent/settings`, em `agent/settings.ts`.
 *
 * `plan-gates.test.ts` confere a tabela contra as rotas registradas.
 */
export const PLAN_GATES: ReadonlyArray<{ prefix: string; feature: PlanFeature }> = [
  { prefix: '/v1/taxi', feature: 'TAXI' },
  { prefix: '/v1/inventory', feature: 'INVENTORY' },
  { prefix: '/v1/site', feature: 'SITE' },
  { prefix: '/v1/messaging/whatsapp', feature: 'WHATSAPP' },
  { prefix: '/v1/crm/campaigns', feature: 'CAMPAIGNS' },
  { prefix: '/v1/crm/runs', feature: 'CAMPAIGNS' },
  { prefix: '/v1/agent', feature: 'AI_AGENT' },
  { prefix: '/v1/agent/stats', feature: 'AI_QUALITY' },
]

function matches(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`)
}

export function featuresForRoute(url: string | undefined): PlanFeature[] {
  if (!url) return []
  return PLAN_GATES.filter((gate) => matches(url, gate.prefix)).map((gate) => gate.feature)
}

/**
 * No nível do app, antes de `registerModules`: um hook registrado ali vale para todos os
 * escopos filhos. Roda antes dos `preHandler` de rota — o 402 vem antes do 403 de
 * permissão, e é o certo: sem o plano, ninguém da equipe tem o que pedir ao administrador.
 */
export function registerPlanGates(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const features = featuresForRoute(request.routeOptions.url)
    if (features.length === 0) return

    // Sem tenant a rota recusa sozinha, com o erro do módulo; o plano não tem a quem
    // perguntar.
    const tenantId = request.authContext?.tenantId
    if (!tenantId) return

    for (const feature of features) await assertFeature(tenantId, feature)
  })
}
