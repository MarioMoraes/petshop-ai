import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { logger, recordMetric } from '../../lib/logger.js'
import { dispatchPending } from './dispatch.js'
import { loadSettings } from './settings.js'

/**
 * Os jobs do relacionamento (§10 do PRD).
 *
 * O despacho é o único que **muda** mensagem; os outros dois relatam e limpam.
 */

export async function runDispatch(now: Date = new Date()): Promise<{ sent: number }> {
  const summary = await dispatchPending(now)
  if (summary.picked > 0) {
    logger.info(summary, 'passada do worker de mensagens')
  }
  return { sent: summary.sent }
}

/**
 * Fila travada (AC-03 de MOD-CRM-11).
 *
 * Não corrige nada — só grita. É o modo de falha mais comum de motor de mensagem e o
 * mais silencioso: nada quebra, nenhum erro aparece no log, e as mensagens simplesmente
 * param de chegar. Quem descobre, hoje, é o cliente que não recebeu.
 */
export async function checkQueueHealth(now: Date = new Date()): Promise<{ stuck: number }> {
  const threshold = new Date(now.getTime() - 30 * 60_000)

  const rows = await getMaintenancePrisma().$queryRaw<{ tenant_id: string; total: bigint }[]>`
    SELECT tenant_id, COUNT(*) AS total
      FROM messages
     WHERE direction = 'OUTBOUND'
       AND status = 'QUEUED'
       AND created_at <= ${threshold}
     GROUP BY tenant_id
    HAVING COUNT(*) >= 200
  `

  for (const row of rows) {
    logger.error(
      { tenantId: row.tenant_id, pending: Number(row.total) },
      'fila de mensagens represada há mais de 30 minutos',
    )
    recordMetric({
      metric: 'message_queue_stuck',
      tenantId: row.tenant_id,
      value: Number(row.total),
      unit: 'count',
    })
  }

  return { stuck: rows.length }
}

/**
 * Retenção (AC-04 de MOD-CRM-10).
 *
 * **Apaga o corpo, preserva a linha.** Os metadados — data, canal, template, status —
 * ficam para estatística e para a prova de que a mensagem existiu; o texto, que é o
 * dado pessoal, some. Guardar conversa antiga sem finalidade é passivo de LGPD.
 */
export async function purgeExpiredBodies(now: Date = new Date()): Promise<{ purged: number }> {
  const tenants = await getMaintenancePrisma().$queryRaw<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM messages WHERE body_encrypted <> ''
  `

  let purged = 0
  for (const { tenant_id: tenantId } of tenants) {
    try {
      const retentionMonths = await withTenant(tenantId, async (tx) => {
        const settings = await loadSettings(tx, tenantId)
        return settings.retentionMonths
      })

      const cutoff = new Date(now)
      cutoff.setMonth(cutoff.getMonth() - retentionMonths)

      const { count } = await withTenant(tenantId, (tx) =>
        tx.message.updateMany({
          where: { createdAt: { lt: cutoff }, bodyEncrypted: { not: '' } },
          data: { bodyEncrypted: '', subjectEncrypted: null, toEncrypted: '' },
        }),
      )
      purged += count
    } catch (error) {
      logger.error({ err: error, tenantId }, 'falha ao expurgar corpos expirados')
    }
  }

  if (purged > 0) logger.info({ purged }, 'corpos de mensagem expurgados pela retenção')
  return { purged }
}
