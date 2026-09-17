import { resolveTenantById, withTenant } from '@petshop/db'
import {
  AppError,
  PLAN_CATALOG,
  PLAN_FEATURE_LABELS,
  PlanSchema,
  minimumPlanFor,
  planIncludes,
  type Plan,
  type PlanFeature,
} from '@petshop/shared-types'
import { recordAudit } from './audit.js'
import { publishEvent } from './events.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from './redis.js'

/**
 * O plano do estabelecimento, na hora de decidir se um recurso responde.
 *
 * A divisão dos recursos mora em `PLAN_CATALOG` (`shared-types/plans.ts`); aqui só se
 * pergunta **qual é o plano deste tenant agora**. Três lugares perguntam:
 *
 * - a tabela de prefixos de `gateway/plan-gates.ts`, para as rotas da equipe;
 * - as superfícies que respondem ao público pelo slug — o site e o Portal —, que
 *   respondem 404 em vez de 402, porque o visitante não tem nada a ver com o plano;
 * - o que roda sem requisição: os jobs de campanha, o canal WhatsApp e o agente.
 *
 * **Tenant sem linha conta como `STARTER`.** É o menor plano, e o erro que ele produz é
 * um recurso a menos — nunca um recurso pago liberado por engano.
 */

export async function tenantPlan(tenantId: string): Promise<Plan> {
  const key = CACHE_KEYS.tenantPlan(tenantId)
  const cached = await cacheGet<Plan>(key)
  if (cached) return cached

  const tenant = await resolveTenantById(tenantId)
  const parsed = PlanSchema.safeParse(tenant?.plan)
  const plan: Plan = parsed.success ? parsed.data : 'STARTER'

  await cacheSet(key, plan, CACHE_TTL_SECONDS.tenantPlan)
  return plan
}

export async function tenantHasFeature(tenantId: string, feature: PlanFeature): Promise<boolean> {
  return planIncludes(await tenantPlan(tenantId), feature)
}

export function planFeatureRequired(feature: PlanFeature, currentPlan: Plan): AppError {
  const requiredPlan = minimumPlanFor(feature)
  return new AppError(
    'ERR_PLAN_001',
    `${PLAN_FEATURE_LABELS[feature]} está disponível a partir do plano ${PLAN_CATALOG[requiredPlan].name}.`,
    undefined,
    { feature, currentPlan, requiredPlan },
  )
}

/** Lança o 402 do catálogo quando o plano do tenant não inclui o recurso. */
export async function assertFeature(tenantId: string, feature: PlanFeature): Promise<void> {
  const plan = await tenantPlan(tenantId)
  if (!planIncludes(plan, feature)) throw planFeatureRequired(feature, plan)
}

/** A troca de plano derruba a leitura em cache, para valer na requisição seguinte. */
export async function invalidateTenantPlan(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.tenantPlan(tenantId))
}

/**
 * Põe o estabelecimento num plano: grava, audita, derruba os caches e avisa o site.
 *
 * Dois caminhos chegam aqui — o console da plataforma e o pagamento confirmado da
 * assinatura —, e os dois precisam das mesmas quatro coisas. O motivo vai para a trilha
 * que o estabelecimento lê: "por que perdi o Taxi Dog?" tem de ter resposta lá.
 *
 * `false` quando o plano já era esse, sem gravar nem publicar nada: o webhook que chega
 * duas vezes não enche a trilha.
 */
export async function applyTenantPlan(
  tenantId: string,
  plan: Plan,
  change: {
    reason: string
    actorUserId?: string | null
    ipAddress?: string | null
    userAgent?: string | null
  },
): Promise<{ changed: boolean; from: Plan }> {
  const result = await withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: true, clerkOrgId: true },
    })
    if (!tenant) return null

    const from = tenant.plan as Plan
    if (from === plan) return { changed: false, from, clerkOrgId: tenant.clerkOrgId }

    await tx.tenant.update({ where: { id: tenantId }, data: { plan } })
    await recordAudit(tx, {
      tenantId,
      action: 'tenant.plan_changed',
      entity: 'tenant',
      entityId: tenantId,
      actorUserId: change.actorUserId ?? null,
      before: { plan: from },
      after: { plan, reason: change.reason },
      ipAddress: change.ipAddress ?? null,
      userAgent: change.userAgent ?? null,
    })
    return { changed: true, from, clerkOrgId: tenant.clerkOrgId }
  })
  if (!result) throw new Error(`Estabelecimento ${tenantId} não encontrado`)
  if (!result.changed) return { changed: false, from: result.from }

  /**
   * O plano vale na requisição seguinte, e não quando os caches expirarem. A configuração
   * do agente entra junto porque ela guarda o **efetivo** — ligado e com persona só no
   * plano que os inclui.
   */
  await invalidateTenantPlan(tenantId)
  await cacheDelete(
    CACHE_KEYS.agentSettings(tenantId),
    ...(result.clerkOrgId ? [CACHE_KEYS.tenantByOrg(result.clerkOrgId)] : []),
  )
  await publishEvent('tenant.plano.alterado', { tenantId, from: result.from, to: plan })

  return { changed: true, from: result.from }
}
