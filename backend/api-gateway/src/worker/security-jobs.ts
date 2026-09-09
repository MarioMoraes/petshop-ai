import type { JobDefinition } from '@petshop/job-scheduler'
import { runAuditRetentionOnce } from '../modules/security/retention.js'

/**
 * A grade do MOD-SEC.
 *
 * Um job só, e de madrugada: às 03h40, depois do expurgo de leads e do de mensagens
 * (ambos às 03h20). A ordem importa pouco, mas escaloná-los evita três varreduras
 * grandes disputando o mesmo disco no mesmo minuto.
 *
 * O `timeoutMs` é maior que o teto interno do job (`AUDIT_RETENTION_MAX_MS`), de
 * propósito: quem decide parar é o job, que devolve `incomplete` e retoma amanhã. Um
 * timeout do agendador menor que o teto interno mataria a execução no meio de um lote e
 * transformaria "não terminou" em "falhou".
 */

export const securityJobs: JobDefinition[] = [
  {
    name: 'security.retention',
    schedule: '40 3 * * *',
    timeoutMs: 10 * 60_000,
    run: (now) => runAuditRetentionOnce(now),
  },
]
