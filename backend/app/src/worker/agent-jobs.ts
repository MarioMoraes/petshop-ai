import type { JobDefinition } from '@petshop/job-scheduler'
import { sweepStaleConversations } from '../modules/agent/service.js'
import { sweepPendingTurns } from '../modules/agent/runner.js'
import { runAgentRetentionOnce } from '../modules/agent/retention.js'

/**
 * A grade do MOD-AI.
 *
 * O varredor de inatividade roda de dez em dez minutos: a expiração de conversa (AC-02 de
 * MOD-AI-02) já é aplicada quando o tutor volta a escrever, e ele existe para o caso em
 * que o tutor **não** volta. O atraso de alguns minutos no fechamento não muda nada para
 * ninguém — o que mudaria é a conversa ficar `ACTIVE` para sempre, e "conversas abertas"
 * deixar de ser um número que significa alguma coisa.
 *
 * O nome do job é identidade em infraestrutura: `job_leases.name` e `job_runs.job_name`
 * são por nome, e renomeá-lo depois perde o histórico e o lease de quem estiver no ar
 * durante o deploy.
 */
export const agentJobs: JobDefinition[] = [
  {
    /**
     * Os turnos que ficaram para trás.
     *
     * O caminho normal é o webhook responder 204 e o turno começar logo em seguida. Este
     * job é a rede: o processo que reinicia no meio, a réplica que morre, o erro que
     * escapa. De minuto em minuto porque o que ele recolhe é um cliente esperando
     * resposta — e o carimbo de posse já impede que ele roube um turno em andamento.
     */
    name: 'agent.sweep-pending',
    schedule: '* * * * *',
    run: (now) => sweepPendingTurns(now),
  },
  {
    name: 'agent.sweep-stale',
    schedule: '*/10 * * * *',
    run: () => sweepStaleConversations(),
  },
  {
    /**
     * A retenção do §9 — o corpo da conversa, o argumento da tool e o vínculo com o
     * titular.
     *
     * Às 03h50, depois dos corpos de mensagem (03h20) e da trilha (03h40): as três
     * varreduras grandes da madrugada ficam escalonadas em vez de disputarem o mesmo
     * disco no mesmo minuto.
     *
     * O `timeoutMs` é maior que o teto interno (`AGENT_RETENTION_MAX_MS`) de propósito,
     * como no expurgo da trilha: quem decide parar é o job, que devolve `incomplete` e
     * retoma amanhã. Um timeout menor que o teto transformaria "não terminou" em
     * "falhou".
     */
    name: 'agent.retention',
    schedule: '50 3 * * *',
    timeoutMs: 10 * 60_000,
    run: (now) => runAgentRetentionOnce(now),
  },
]
