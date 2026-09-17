import { getMaintenancePrisma } from '@petshop/db'
import { PLAN_CATALOG, type ChangeTenantPlanInput, type Plan } from '@petshop/shared-types'
import { recordPlatformAudit } from '../../shared/audit.js'
import { applyTenantPlan } from '../../shared/plan.js'
import { invalidState, notFound } from './errors.js'

/**
 * A troca de plano pelo console (fatia 2 da camada comercial).
 *
 * **Por que a plataforma ainda troca plano, agora que existe assinatura.** A subida e a
 * descida do Starter e do Pro nascem do pagamento (`modules/subscription`). Esta rota fica
 * para o que não passa por ele: o Enterprise, que é sob consulta, a cortesia, a correção.
 *
 * **Descer de plano não apaga nada.** Os dados do Taxi Dog, as campanhas agendadas, o
 * número pareado e a persona do agente ficam onde estão; o que muda é o que responde.
 */

export interface PlanChangeActor {
  userId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export async function changeTenantPlan(
  actor: PlanChangeActor,
  tenantId: string,
  input: ChangeTenantPlanInput,
): Promise<{ tenantId: string; plan: Plan }> {
  const tenant = await getMaintenancePrisma().tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { plan: true },
  })
  if (!tenant) throw notFound('Estabelecimento não encontrado')
  if (tenant.plan === input.plan) {
    throw invalidState(`O estabelecimento já está no plano ${PLAN_CATALOG[input.plan].name}`)
  }

  // Duas trilhas, e as duas com o motivo: a do estabelecimento (em `applyTenantPlan`) e a
  // da plataforma, que responde por quem da equipe mexeu.
  const { from } = await applyTenantPlan(tenantId, input.plan, {
    reason: input.reason,
    actorUserId: actor.userId,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  await recordPlatformAudit({
    action: 'platform.tenant_plan_changed',
    entity: 'tenant',
    entityId: tenantId,
    actorUserId: actor.userId,
    before: { plan: from },
    after: { plan: input.plan, reason: input.reason },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  return { tenantId, plan: input.plan }
}
