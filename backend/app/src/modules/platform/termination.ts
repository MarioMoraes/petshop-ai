import { getMaintenancePrisma } from '@petshop/db'
import type { ReopenTenantInput, TerminateTenantInput } from '@petshop/shared-types'
import { recordPlatformAudit } from '../../shared/audit.js'
import { invalid, invalidState, notFound } from './errors.js'
import type { PlanChangeActor } from './plans.js'
import { getTerminationPort } from './termination-port.js'

/**
 * Encerrar um estabelecimento pelo console (MOD-IDENT-10 AC-02).
 *
 * Só a equipe da plataforma encerra — decisão do produto: um clique do próprio petshop
 * apagaria a base inteira dele no D+30. O endereço digitado é a confirmação de **qual**
 * conta; o motivo vai às duas trilhas, como na troca de plano.
 */
export async function terminateTenantFromConsole(
  actor: PlanChangeActor,
  tenantId: string,
  input: TerminateTenantInput,
): Promise<{ tenantId: string; status: 'TERMINATED' }> {
  const tenant = await getMaintenancePrisma().tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { slug: true, status: true },
  })
  if (!tenant) throw notFound('Estabelecimento não encontrado')
  if (input.confirmSlug.toLowerCase() !== tenant.slug) {
    throw invalid('O endereço digitado não é o deste estabelecimento', [
      { field: 'confirmSlug', message: `Digite ${tenant.slug} para confirmar` },
    ])
  }
  if (tenant.status === 'PROVISIONING') {
    throw invalidState('O estabelecimento ainda está sendo criado')
  }

  const result = await getTerminationPort().terminate(tenantId, {
    reason: input.reason,
    actorUserId: actor.userId,
  })
  if (result === 'ALREADY') throw invalidState('O estabelecimento já está encerrado')
  if (result === 'NOT_FOUND') throw notFound('Estabelecimento não encontrado')

  await recordPlatformAudit({
    action: 'platform.tenant_terminated',
    entity: 'tenant',
    entityId: tenantId,
    actorUserId: actor.userId,
    before: { status: tenant.status },
    after: { status: 'TERMINATED', reason: input.reason },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })
  return { tenantId, status: 'TERMINATED' }
}

/** Reabrir até o D+30. Depois do expurgo não há o que reabrir. */
export async function reopenTenantFromConsole(
  actor: PlanChangeActor,
  tenantId: string,
  input: ReopenTenantInput,
): Promise<{ tenantId: string; status: 'SUSPENDED' }> {
  const result = await getTerminationPort().reopen(tenantId, { actorUserId: actor.userId })
  if (result === 'NOT_REOPENABLE') {
    throw invalidState(
      'Só reabre um estabelecimento encerrado há menos de 30 dias e ainda não anonimizado',
    )
  }

  await recordPlatformAudit({
    action: 'platform.tenant_reopened',
    entity: 'tenant',
    entityId: tenantId,
    actorUserId: actor.userId,
    before: { status: 'TERMINATED' },
    after: { status: 'SUSPENDED', reason: input.reason },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })
  return { tenantId, status: 'SUSPENDED' }
}
