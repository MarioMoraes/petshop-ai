import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  SITE_LEAD_ABUSE_METADATA_DAYS,
  SITE_LEAD_DISCARD_AFTER_DAYS,
  SITE_LEAD_PURGE_AFTER_DAYS,
} from '@petshop/shared-types'
import { logger } from '../../lib/logger.js'

/**
 * A retenção dos leads (RN-11 e §10).
 *
 * Varre todos os tenants: a consulta usa `app_maintenance` (com BYPASSRLS), como os
 * jobs da agenda e do taxi. Descobrir é cross-tenant; agir sobre um registro nunca é —
 * a varredura devolve `(id, tenant_id)` e cada escrita roda dentro de `withTenant()`,
 * com a política RLS ativa e limitada aos ids que aquela varredura encontrou.
 *
 * **Por que a escrita não é cross-tenant.** O passo 2 apaga PII de forma
 * irreversível. Um `updateMany` no cliente de manutenção com `WHERE` só de data
 * atingiria todos os tenants numa instrução: um erro de aritmética de data, ou uma
 * constante mal configurada, destruiria o dado de toda a base sem nada para limitar o
 * alcance. Passando por `withTenant()`, a RLS é o teto — o pior caso fica contido em
 * um tenant.
 *
 * **Por que existe.** O lead é a única categoria de dado pessoal do sistema sem
 * finalidade continuada: quem preencheu o formulário e nunca virou cliente não tem
 * relação com o petshop, e guardar o telefone dele indefinidamente é passivo sem
 * contrapartida. Doze meses até o descarte, mais doze até apagar o PII; a linha fica,
 * sem nome nem telefone, para a estatística de quantos contatos chegaram.
 *
 * O IP e o user-agent têm prazo próprio e mais curto (90 dias): são antiabuso, e
 * antiabuso que olha um ano para trás não serve para nada.
 */

/**
 * Teto de cada varredura. A retenção é idempotente e roda de novo no próximo ciclo,
 * então um lote cheio não perde dado — só adia. O log de `lote cheio` existe para que
 * um acúmulo permanente apareça, em vez de virar backlog silencioso.
 */
const SCAN_LIMIT = 1_000

interface LeadRow {
  id: string
  tenant_id: string
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/** Agrupa a varredura por tenant: uma transação por petshop, não uma por linha. */
function groupByTenant(rows: LeadRow[]): Map<string, string[]> {
  const byTenant = new Map<string, string[]>()
  for (const row of rows) {
    const ids = byTenant.get(row.tenant_id)
    if (ids) ids.push(row.id)
    else byTenant.set(row.tenant_id, [row.id])
  }
  return byTenant
}

function warnIfBatchFull(rows: LeadRow[], step: string): void {
  if (rows.length >= SCAN_LIMIT) {
    logger.warn({ step, limit: SCAN_LIMIT }, 'lote cheio: a retenção continua no próximo ciclo')
  }
}

/**
 * Aplica `mutate` aos ids encontrados, um tenant por vez. Uma falha num tenant não
 * pode impedir a retenção dos outros — é dado pessoal com prazo vencido em todos.
 */
async function applyPerTenant(
  rows: LeadRow[],
  step: string,
  mutate: (tx: TenantTransaction, ids: string[]) => Promise<number>,
): Promise<number> {
  let affected = 0
  for (const [tenantId, ids] of groupByTenant(rows)) {
    try {
      affected += await withTenant(tenantId, (tx) => mutate(tx, ids))
    } catch (error) {
      logger.error({ err: error, tenantId, step, leads: ids.length }, 'falha na retenção de leads')
    }
  }
  return affected
}

export async function runLeadRetention(
  now: Date = new Date(),
): Promise<{ discarded: number; purged: number; anonymized: number }> {
  const db = getMaintenancePrisma()

  // 1. Sem retorno há doze meses: vai para descartado, mantendo o PII por mais um ano
  //    — o contato pode voltar, e a equipe reconhece o nome.
  const discardCutoff = daysAgo(now, SITE_LEAD_DISCARD_AFTER_DAYS)
  const toDiscard = await db.$queryRaw<LeadRow[]>`
    SELECT id, tenant_id FROM site_leads
     WHERE status = 'NEW' AND created_at < ${discardCutoff}
     ORDER BY created_at ASC
     LIMIT ${SCAN_LIMIT}
  `
  warnIfBatchFull(toDiscard, 'discard')
  const discarded = await applyPerTenant(toDiscard, 'discard', async (tx, ids) => {
    const result = await tx.siteLead.updateMany({
      where: { id: { in: ids }, status: 'NEW' },
      data: { status: 'DISCARDED' },
    })
    return result.count
  })

  // 2. Descartado há mais de um ano: o PII some e a linha fica.
  const purgeCutoff = daysAgo(now, SITE_LEAD_DISCARD_AFTER_DAYS + SITE_LEAD_PURGE_AFTER_DAYS)
  const toPurge = await db.$queryRaw<LeadRow[]>`
    SELECT id, tenant_id FROM site_leads
     WHERE status = 'DISCARDED' AND purged_at IS NULL AND created_at < ${purgeCutoff}
     ORDER BY created_at ASC
     LIMIT ${SCAN_LIMIT}
  `
  warnIfBatchFull(toPurge, 'purge')
  const purged = await applyPerTenant(toPurge, 'purge', async (tx, ids) => {
    const result = await tx.siteLead.updateMany({
      where: { id: { in: ids }, purgedAt: null },
      data: {
        name: '(removido)',
        phoneEncrypted: '',
        phoneHash: '',
        emailEncrypted: null,
        message: null,
        ipAddress: null,
        userAgent: null,
        purgedAt: now,
      },
    })
    return result.count
  })

  // 3. Metadado de antiabuso, em qualquer status.
  const abuseCutoff = daysAgo(now, SITE_LEAD_ABUSE_METADATA_DAYS)
  const toAnonymize = await db.$queryRaw<LeadRow[]>`
    SELECT id, tenant_id FROM site_leads
     WHERE created_at < ${abuseCutoff}
       AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)
     ORDER BY created_at ASC
     LIMIT ${SCAN_LIMIT}
  `
  warnIfBatchFull(toAnonymize, 'anonymize')
  const anonymized = await applyPerTenant(toAnonymize, 'anonymize', async (tx, ids) => {
    const result = await tx.siteLead.updateMany({
      where: {
        id: { in: ids },
        OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
      },
      data: { ipAddress: null, userAgent: null },
    })
    return result.count
  })

  if (discarded + purged + anonymized > 0) {
    logger.info({ discarded, purged, anonymized }, 'retenção de leads executada')
  }

  return { discarded, purged, anonymized }
}
