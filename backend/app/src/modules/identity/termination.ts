import { clearTenantKeyCache, getMaintenancePrisma, withTenant } from '@petshop/db'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import {
  TENANT_TERMINATION_GRACE_DAYS,
  reopenTenantStatus,
  terminateTenantStatus,
} from '../../shared/tenant-status.js'
import { getClerk } from './clerk.js'
import { getTenantPurgePort } from './purge-port.js'

/**
 * O encerramento do estabelecimento (MOD-IDENT-10 AC-02), em três tempos:
 *
 * 1. **Encerrar** (console da plataforma): `TERMINATED`, todo acesso fechado na sessão,
 *    a mensalidade cancelada no Asaas e as integrações com terceiros desligadas.
 * 2. **Reabrir** (console, até D+30): volta a `SUSPENDED` — o petshop assina de novo pelo
 *    caminho de sempre. As integrações não voltam sozinhas: ele as conecta outra vez.
 * 3. **Expurgar** (job diário, depois do D+30): todo dado pessoal sai, e por fim a chave
 *    do estabelecimento (DEK) é destruída — o que torna ilegível todo campo cifrado,
 *    inclusive nas tabelas append-only que nenhum `UPDATE` alcança. Fica o que a lei manda
 *    guardar por 5 anos: lançamentos, pagamentos, caixa, documentos e a trilha.
 *
 * **Nenhum passo apaga a linha do tenant.** O produto não tem `DELETE` de estabelecimento
 * (ver o cascade incompleto), e a linha é o que ancora os 5 anos de registro fiscal.
 */

export type TerminateResult = 'TERMINATED' | 'ALREADY' | 'NOT_FOUND'

export async function terminateTenant(
  tenantId: string,
  input: { reason: string; actorUserId: string | null; now?: Date },
): Promise<TerminateResult> {
  const tenant = await getMaintenancePrisma().tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { status: true },
  })
  if (!tenant) return 'NOT_FOUND'

  const changed = await terminateTenantStatus(tenantId, input)
  if (!changed) return 'ALREADY'

  // Depois do estado, e cada um por conta própria: o terceiro fora do ar não desfaz o
  // encerramento — a sessão já está fechada, e o que falhar aqui fica no log.
  const port = getTenantPurgePort()
  await port.cancelSubscription(tenantId).catch((error: unknown) => {
    logger.error({ err: error, tenantId }, 'encerramento: assinatura não cancelada no Asaas')
  })
  await port.disconnectIntegrations(tenantId).catch((error: unknown) => {
    logger.error({ err: error, tenantId }, 'encerramento: integração não desligada')
  })
  return 'TERMINATED'
}

export type ReopenResult = 'REOPENED' | 'NOT_REOPENABLE'

export async function reopenTenant(
  tenantId: string,
  input: { actorUserId: string | null; now?: Date },
): Promise<ReopenResult> {
  return (await reopenTenantStatus(tenantId, input)) ? 'REOPENED' : 'NOT_REOPENABLE'
}

export interface TenantPurgeResult {
  tenants: number
  failed: number
}

/** O job `identity.tenant-purge`: todo encerrado cuja janela de 30 dias passou. */
export async function runTenantPurgeOnce(now = new Date()): Promise<TenantPurgeResult> {
  const cutoff = new Date(now.getTime() - TENANT_TERMINATION_GRACE_DAYS * 24 * 60 * 60_000)
  const due = await getMaintenancePrisma().tenant.findMany({
    where: { status: 'TERMINATED', purgedAt: null, terminatedAt: { lte: cutoff } },
    select: { id: true },
  })

  const result: TenantPurgeResult = { tenants: 0, failed: 0 }
  for (const { id } of due) {
    try {
      await purgeTenant(id, now)
      result.tenants += 1
    } catch (error) {
      // Um estabelecimento que falha não segura os outros; ele volta amanhã, e cada passo
      // é reexecutável.
      result.failed += 1
      logger.error({ err: error, tenantId: id }, 'expurgo do encerramento falhou; retoma amanhã')
    }
  }
  if (due.length > 0) logger.info(result, 'expurgo de estabelecimentos encerrados')
  return result
}

async function purgeTenant(tenantId: string, now: Date): Promise<void> {
  const port = getTenantPurgePort()

  // Primeiro o que precisa da chave para ler o que apaga (o WhatsApp decifra a sua para
  // falar com o provedor); a chave é a última coisa a sair.
  await port.disconnectIntegrations(tenantId)
  const tutors = await port.anonymizeTutors(tenantId)
  const photos = await port.purgePhotos(tenantId)
  const conversations = await port.purgeAgentConversations(tenantId)
  await port.purgeContacts(tenantId)

  const tenant = await getMaintenancePrisma().tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { clerkOrgId: true },
  })
  if (tenant.clerkOrgId) await getClerk().deleteOrganization(tenant.clerkOrgId)

  await withTenant(tenantId, async (tx) => {
    await tx.membership.updateMany({
      where: { status: { not: 'REMOVED' } },
      data: { status: 'REMOVED' },
    })
    await tx.invitation.deleteMany({})
    await tx.tenantSettings.updateMany({ data: { publicPhone: null } })
    await tx.tenant.update({
      where: { id: tenantId },
      data: { cnpjEncrypted: null, clerkOrgId: null, purgedAt: now },
    })
    await tx.dataKey.deleteMany({ where: { tenantId } })
    await recordAudit(tx, {
      tenantId,
      action: 'tenant.purged',
      entity: 'tenant',
      entityId: tenantId,
      after: { tutors, photos, conversations },
    })
  })
  clearTenantKeyCache(tenantId)
}
