import { getMaintenancePrisma } from '@petshop/db'
import { loadEnv } from '../../config/env.js'
import { logger, recordMetric } from '../../shared/logger.js'

/**
 * A retenção da trilha e dos eventos de segurança (MOD-SEC-08).
 *
 * **Cross-tenant do começo ao fim, e aqui isso é o certo.** O expurgo do lead passa por
 * `withTenant` porque apaga PII de um cliente e a RLS é o teto que contém um erro de
 * aritmética de data. Aqui o critério é só idade, o alvo é a instalação inteira —
 * inclusive as linhas de plataforma, com `tenant_id` nulo, que nenhum `withTenant`
 * alcançaria — e amarrar a varredura a um tenant deixaria justamente essas de fora, para
 * sempre.
 *
 * **A trilha continua imutável; o que se abriu foi a saída.** A migration do módulo dá
 * `DELETE` em `audit_logs` a `app_maintenance` e mantém `UPDATE` barrado para todos,
 * inclusive ela. É a diferença entre expurgo e falsificação, e ela está no schema, não
 * na disciplina de quem escreve este arquivo.
 *
 * **Por que a retenção é parte do módulo e não um refino depois.** `ip_address` e
 * `user_agent` de um funcionário são dado pessoal guardado sob legítimo interesse, e
 * legítimo interesse tem prazo: o mesmo rastro por vinte e quatro meses cobre qualquer
 * disputa que alguém vá investigar, e para sempre não se sustenta. É a retenção que
 * torna a base legal defensável.
 */

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export interface RetentionResult {
  auditLogs: number
  securityEvents: number
  /** `true` quando o teto de tempo cortou a execução — o resto fica para amanhã. */
  incomplete: boolean
}

export async function runAuditRetentionOnce(now = new Date()): Promise<RetentionResult> {
  const env = loadEnv()
  const cutoff = new Date(now.getTime() - env.AUDIT_RETENTION_MONTHS * MONTH_MS)
  const deadline = now.getTime() + env.AUDIT_RETENTION_MAX_MS

  const result: RetentionResult = { auditLogs: 0, securityEvents: 0, incomplete: false }

  result.auditLogs = await purge('audit_logs', cutoff, deadline, env.AUDIT_RETENTION_BATCH, result)
  result.securityEvents = await purge(
    'security_events',
    cutoff,
    deadline,
    env.AUDIT_RETENTION_BATCH,
    result,
  )

  // Duas métricas, e não uma com a tabela num campo: `BusinessMetric` é `{ metric,
  // tenantId, value, unit }`, e alargá-la por causa deste job mudaria um tipo que todo
  // módulo usa. Zero por vários dias seguidos, com a tabela grande, quer dizer que o job
  // parou de apagar.
  recordMetric({ metric: 'audit_retention_deleted_logs', value: result.auditLogs, unit: 'count' })
  recordMetric({
    metric: 'audit_retention_deleted_events',
    value: result.securityEvents,
    unit: 'count',
  })

  if (result.auditLogs + result.securityEvents > 0) {
    logger.info({ ...result, cutoff: cutoff.toISOString() }, 'expurgo da trilha concluído')
  }

  return result
}

/**
 * O expurgo de uma tabela, em lotes.
 *
 * **Um `DELETE` único sobre dois anos acumulados é o defeito que este laço evita.** Ele
 * segura o lock e infla o WAL justamente no horário em que o backup roda, e a primeira
 * execução depois do deploy é a maior de todas. O job é diário e idempotente: não
 * precisa terminar hoje.
 *
 * O `IN (SELECT ... LIMIT)` é o que dá o lote — o Postgres não aceita `LIMIT` num
 * `DELETE`. Os dois nomes de tabela são literais deste arquivo, nunca entrada de
 * ninguém.
 */
async function purge(
  table: 'audit_logs' | 'security_events',
  cutoff: Date,
  deadline: number,
  batch: number,
  result: RetentionResult,
): Promise<number> {
  const prisma = getMaintenancePrisma()
  let total = 0

  for (;;) {
    if (Date.now() > deadline) {
      result.incomplete = true
      logger.warn({ table, total }, 'expurgo interrompido pelo teto de tempo; retoma amanhã')
      return total
    }

    const deleted =
      table === 'audit_logs'
        ? await prisma.$executeRaw`
            DELETE FROM "audit_logs"
             WHERE id IN (
               SELECT id FROM "audit_logs" WHERE created_at < ${cutoff} LIMIT ${batch}
             )`
        : await prisma.$executeRaw`
            DELETE FROM "security_events"
             WHERE id IN (
               SELECT id FROM "security_events" WHERE created_at < ${cutoff} LIMIT ${batch}
             )`

    total += deleted
    if (deleted < batch) return total
  }
}
