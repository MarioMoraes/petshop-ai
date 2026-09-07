import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../env.js'
import { logger, recordMetric } from '../lib/logger.js'
import { retryPendingTermDocuments } from '../modules/terms/acceptance.js'

/**
 * A grade do cadastro.
 *
 * Um job só: o reprocesso de documento (MOD-DOC-11). De dez em dez minutos, e não de
 * madrugada, pelo mesmo motivo do recibo e do receituário — um termo que não saiu é um
 * tutor no balcão esperando o papel agora, não amanhã.
 */

export const { startJobs, stopJobs, runJobNow } = createJobScheduler({
  service: 'tutor-service',
  logger,
  recordMetric,
  isDisabled: () => loadEnv().DISABLE_JOBS,
  jobs: [
    {
      name: 'tutor.retry-term-documents',
      schedule: '*/10 * * * *',
      timeoutMs: 5 * 60_000,
      run: (now) => retryPendingTermDocuments(now),
    },
  ],
})
