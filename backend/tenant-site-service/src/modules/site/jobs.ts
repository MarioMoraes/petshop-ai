import { getMaintenancePrisma } from '@petshop/db'
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
 * e aqui a ação é apagar coluna, na mesma linha que a varredura encontrou.
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

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

export async function runLeadRetention(
  now: Date = new Date(),
): Promise<{ discarded: number; purged: number; anonymized: number }> {
  const db = getMaintenancePrisma()

  // 1. Sem retorno há doze meses: vai para descartado, mantendo o PII por mais um ano
  //    — o contato pode voltar, e a equipe reconhece o nome.
  const discarded = await db.siteLead.updateMany({
    where: { status: 'NEW', createdAt: { lt: daysAgo(now, SITE_LEAD_DISCARD_AFTER_DAYS) } },
    data: { status: 'DISCARDED' },
  })

  // 2. Descartado há mais de um ano: o PII some e a linha fica.
  const purgeCutoff = daysAgo(now, SITE_LEAD_DISCARD_AFTER_DAYS + SITE_LEAD_PURGE_AFTER_DAYS)
  const purged = await db.siteLead.updateMany({
    where: { status: 'DISCARDED', purgedAt: null, createdAt: { lt: purgeCutoff } },
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

  // 3. Metadado de antiabuso, em qualquer status.
  const anonymized = await db.siteLead.updateMany({
    where: {
      createdAt: { lt: daysAgo(now, SITE_LEAD_ABUSE_METADATA_DAYS) },
      OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
    },
    data: { ipAddress: null, userAgent: null },
  })

  if (discarded.count + purged.count + anonymized.count > 0) {
    logger.info(
      { discarded: discarded.count, purged: purged.count, anonymized: anonymized.count },
      'retenção de leads executada',
    )
  }

  return { discarded: discarded.count, purged: purged.count, anonymized: anonymized.count }
}
