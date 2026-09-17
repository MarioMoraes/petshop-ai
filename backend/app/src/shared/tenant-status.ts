import { getMaintenancePrisma, withTenant } from '@petshop/db'
import type { TenantStatus } from '@petshop/shared-types'
import { recordAudit } from './audit.js'
import { publishEvent } from './events.js'
import { logger } from './logger.js'
import { CACHE_KEYS, cacheDelete } from './redis.js'

/**
 * A mudança de estado da **conta** do estabelecimento — teste, ativo, em atraso, suspenso.
 *
 * Três caminhos chegam aqui, e nenhum vem de uma tela: o fim do teste (job), o pagamento
 * que o Asaas confirma (webhook) e a carência de atraso que vence (job). Por isso a
 * transição mora no host, como `plan.ts`, e não num módulo: um módulo chamaria outro para
 * mudar o estado da conta, e a lista de quem pode fazer isso ficaria espalhada.
 *
 * **A transição é condicional ao estado de origem**, no `WHERE`. O webhook que chega
 * duas vezes e o job que roda em duas réplicas não aplicam a mesma mudança duas vezes, e
 * o pagamento que chega depois de o teste vencer não é desfeito pelo job atrasado.
 */

/**
 * O evento de cada transição. Voltar a `ACTIVE` é `ativado` na primeira vez (saindo do
 * teste) e `reativado` depois de atraso ou suspensão; `PAST_DUE` não publica nada, porque
 * o estabelecimento em atraso continua operando e nenhum consumidor tem o que fazer.
 */
function routingKeyFor(
  from: TenantStatus,
  to: TenantStatus,
): 'tenant.ativado' | 'tenant.suspenso' | 'tenant.reativado' | null {
  if (to === 'SUSPENDED' || to === 'TRIAL_EXPIRED') return 'tenant.suspenso'
  if (to !== 'ACTIVE') return null
  return from === 'TRIAL' || from === 'TRIAL_EXPIRED' ? 'tenant.ativado' : 'tenant.reativado'
}

export interface TenantStatusTransition {
  from: readonly TenantStatus[]
  to: TenantStatus
  /** Vai na trilha e no evento: `TRIAL_EXPIRED`, `PAYMENT_CONFIRMED`, `OVERDUE_GRACE_ENDED`. */
  reason: string
  actorUserId?: string | null
}

/** `true` quando mudou; `false` quando o estabelecimento já não estava num dos `from`. */
export async function transitionTenantStatus(
  tenantId: string,
  transition: TenantStatusTransition,
): Promise<boolean> {
  const tenant = await getMaintenancePrisma().tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { status: true, slug: true, clerkOrgId: true },
  })
  if (!tenant || !transition.from.includes(tenant.status as TenantStatus)) return false

  const changed = await withTenant(tenantId, async (tx) => {
    const { count } = await tx.tenant.updateMany({
      where: { id: tenantId, status: { in: [...transition.from] } },
      data: { status: transition.to },
    })
    if (count === 0) return false

    await recordAudit(tx, {
      tenantId,
      action: 'tenant.status_changed',
      entity: 'tenant',
      entityId: tenantId,
      actorUserId: transition.actorUserId ?? null,
      before: { status: tenant.status },
      after: { status: transition.to, reason: transition.reason },
    })
    return true
  })
  if (!changed) return false

  /**
   * Os caches que guardam o estado, todos de uma vez. O da sessão tem TTL de um minuto; os
   * do slug do site e do Portal guardam **uma hora** a resolução positiva — sem derrubá-los,
   * um teste vencido manteria o Portal no ar por mais uma hora, e uma assinatura paga
   * deixaria o site fora do ar pelo mesmo tempo.
   */
  await cacheDelete(
    CACHE_KEYS.tenantStatus(tenantId),
    CACHE_KEYS.portalTenantBySlug(tenant.slug),
    CACHE_KEYS.host(tenant.slug),
    CACHE_KEYS.hostMiss(tenant.slug),
    ...(tenant.clerkOrgId ? [CACHE_KEYS.tenantByOrg(tenant.clerkOrgId)] : []),
  )

  const routingKey = routingKeyFor(tenant.status as TenantStatus, transition.to)
  if (routingKey) {
    await publishEvent(routingKey, {
      tenantId,
      previousStatus: tenant.status as TenantStatus,
      newStatus: transition.to,
      reason: transition.reason,
    })
  }

  logger.info(
    { tenantId, from: tenant.status, to: transition.to, reason: transition.reason },
    'estado do estabelecimento alterado',
  )
  return true
}
