import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { tenantOperates, type TenantStatus } from '@petshop/shared-types'
import { recordAudit } from './audit.js'
import { publishEvent } from './events.js'
import { logger } from './logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from './redis.js'

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
 * teste) e `reativado` depois de atraso ou suspensão.
 *
 * **`PAST_DUE` passou a publicar.** Enquanto ninguém avisava o estabelecimento, o atraso
 * era um estado sem consequência visível e o evento não teria ouvinte; com o aviso de
 * mensalidade vencida, ele é o fato que dispara o e-mail. O estabelecimento continua
 * operando — o que muda é que ele fica sabendo.
 */
function routingKeyFor(
  from: TenantStatus,
  to: TenantStatus,
):
  | 'tenant.ativado'
  | 'tenant.suspenso'
  | 'tenant.reativado'
  | 'tenant.em_atraso'
  | 'tenant.encerrado'
  | null {
  if (to === 'TERMINATED') return 'tenant.encerrado'
  // Reabrir um encerrado volta a `SUSPENDED`, mas não é uma suspensão nova: publicar
  // `tenant.suspenso` mandaria ao administrador o aviso de mensalidade em atraso.
  if (from === 'TERMINATED') return null
  if (to === 'SUSPENDED' || to === 'TRIAL_EXPIRED') return 'tenant.suspenso'
  if (to === 'PAST_DUE') return 'tenant.em_atraso'
  if (to !== 'ACTIVE') return null
  return from === 'TRIAL' || from === 'TRIAL_EXPIRED' ? 'tenant.ativado' : 'tenant.reativado'
}

export interface TenantStatusTransition {
  from: readonly TenantStatus[]
  to: TenantStatus
  /** Vai na trilha e no evento: `TRIAL_EXPIRED`, `PAYMENT_CONFIRMED`, `OVERDUE_GRACE_ENDED`. */
  reason: string
  actorUserId?: string | null
  /**
   * Colunas gravadas na **mesma** escrita da mudança de estado — o encerramento carimba
   * `terminatedAt`, e um estado sem o carimbo deixaria o D+30 sem ponto de partida.
   */
  data?: { terminatedAt?: Date | null; terminationReason?: string | null }
  /** Condição a mais no `WHERE` da transição, para a regra que não é só o estado. */
  where?: { purgedAt?: null; terminatedAt?: { gt: Date } }
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
      where: { id: tenantId, status: { in: [...transition.from] }, ...transition.where },
      data: { status: transition.to, ...transition.data },
    })
    if (count === 0) return false

    await recordAudit(tx, {
      tenantId,
      action: 'tenant.status_changed',
      entity: 'tenant',
      entityId: tenantId,
      actorUserId: transition.actorUserId ?? null,
      before: { status: tenant.status },
      after: { status: transition.to, reason: transition.reason, ...transition.data },
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
    /**
     * A configuração do agente guarda o **efetivo**, e o estado da conta entra nele: a
     * suspensão o desliga. Sem esta linha, o agente responderia por mais cinco minutos em
     * nome de um estabelecimento que já não opera — e a mensagem dele é a única do produto
     * que chega ao cliente final sem passar pela fila.
     */
    CACHE_KEYS.agentSettings(tenantId),
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

/**
 * O estabelecimento opera? — a pergunta de quem roda **fora** da requisição.
 *
 * Na porta, o estado já veio junto do tenant da sessão e custa zero. O despacho de
 * mensagens, as varreduras diárias e o turno do agente não têm requisição nenhuma: para
 * eles o estado é uma consulta, e por isso passa pelo mesmo `tenant:status` que a sessão
 * escreve — TTL de um minuto, derrubado pela transição acima. É o que impede o caminho
 * mais quente do sistema de perguntar a cada mensagem.
 *
 * **Tenant que não existe não opera.** Aqui a ausência é um `deletedAt` preenchido, e não
 * um estado que ninguém reconheceu — o contrário do `tenantOperates`, que deixa passar o
 * desconhecido porque lá a alternativa seria travar o produto por um enum novo.
 */
export async function tenantOperational(tenantId: string): Promise<boolean> {
  const cached = await cacheGet<string>(CACHE_KEYS.tenantStatus(tenantId))
  if (cached) return tenantOperates(cached)

  const tenant = await getMaintenancePrisma().tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { status: true },
  })
  if (!tenant) return false

  await cacheSet(CACHE_KEYS.tenantStatus(tenantId), tenant.status, CACHE_TTL_SECONDS.tenantStatus)
  return tenantOperates(tenant.status)
}

/** Os dias entre o encerramento e a anonimização — a janela em que o console reabre. */
export const TENANT_TERMINATION_GRACE_DAYS = 30

/** Quando a anonimização do encerramento vence. */
export function tenantPurgeDueAt(terminatedAt: Date): Date {
  return new Date(terminatedAt.getTime() + TENANT_TERMINATION_GRACE_DAYS * 24 * 60 * 60_000)
}

/**
 * Encerra a conta (MOD-IDENT-10 AC-02). Vale de qualquer estado que já tenha conta no
 * Clerk; `PROVISIONING` fica de fora porque ainda não há o que encerrar.
 */
export function terminateTenantStatus(
  tenantId: string,
  input: { reason: string; actorUserId?: string | null; now?: Date },
): Promise<boolean> {
  return transitionTenantStatus(tenantId, {
    from: ['TRIAL', 'TRIAL_EXPIRED', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'PROVISIONING_FAILED'],
    to: 'TERMINATED',
    reason: 'TERMINATED_BY_PLATFORM',
    actorUserId: input.actorUserId ?? null,
    data: { terminatedAt: input.now ?? new Date(), terminationReason: input.reason },
  })
}

/**
 * Desfaz o encerramento enquanto a anonimização não passou. Volta a `SUSPENDED`, e não ao
 * estado anterior: quem reabre paga pela assinatura, que é o caminho que já reativa.
 */
export function reopenTenantStatus(
  tenantId: string,
  input: { actorUserId?: string | null; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const limite = new Date(now.getTime() - TENANT_TERMINATION_GRACE_DAYS * 24 * 60 * 60_000)
  return transitionTenantStatus(tenantId, {
    from: ['TERMINATED'],
    to: 'SUSPENDED',
    reason: 'REOPENED_BY_PLATFORM',
    actorUserId: input.actorUserId ?? null,
    data: { terminatedAt: null, terminationReason: null },
    // No `WHERE`, e não numa leitura antes: o expurgo do D+30 pode estar rodando agora.
    where: { purgedAt: null, terminatedAt: { gt: limite } },
  })
}
