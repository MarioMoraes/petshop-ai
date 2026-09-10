import type { JobDefinition } from '@petshop/job-scheduler'
import { evaluateAlerts } from '../modules/platform/alerts.js'
import { compactMetrics, rollUpMetrics } from '../modules/platform/metrics.js'

/**
 * A grade do MOD-ADMIN.
 *
 * **O roll-up é o único job do produto que não pode atrasar sem perder dado.** Os outros
 * varrem o banco e encontram o mesmo trabalho meia hora depois; este drena um acumulador
 * em memória, e o que ele não drenar antes de o processo reiniciar não existe mais
 * (RN-08). Daí o intervalo curto e o teto de execução baixo.
 *
 * A avaliação de alertas roda no mesmo compasso de propósito: é ela que define o que "duas
 * avaliações seguidas" significa em minutos — dez, aqui —, e a janela de agrupamento de
 * notificação do AC-04 é exatamente este intervalo.
 */

export const platformJobs: JobDefinition[] = [
  {
    name: 'platform.roll-up-metrics',
    schedule: '*/5 * * * *',
    timeoutMs: 60_000,
    run: () => rollUpMetrics(),
  },
  {
    /**
     * Um minuto depois do roll-up, e não no mesmo: as duas regras de job leem
     * `job_runs`, e avaliar no mesmo minuto em que meia dúzia de varreduras começa daria
     * alarme por execução ainda em curso.
     */
    name: 'platform.evaluate-alerts',
    schedule: '1-56/5 * * * *',
    timeoutMs: 60_000,
    run: (now) => evaluateAlerts(now),
  },
  {
    /**
     * De madrugada, e depois dos expurgos do MOD-SEC e do MOD-NOTIF: a compactação lê
     * trinta dias de baldes de cinco minutos, e é a varredura mais larga da grade.
     */
    name: 'platform.compact-metrics',
    schedule: '50 3 * * *',
    timeoutMs: 10 * 60_000,
    run: (now) => compactMetrics(now),
  },
]
