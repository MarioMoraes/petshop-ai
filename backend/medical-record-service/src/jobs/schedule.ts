import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../env.js'
import { logger, recordMetric } from '../lib/logger.js'
import { retryPendingPrescriptions } from '../modules/prescriptions/service.js'

/**
 * A grade do prontuário.
 *
 * Um job só, por ora: o reprocesso de documento (MOD-DOC-11). De dez em dez minutos, e
 * não de madrugada, pelo mesmo motivo do recibo — um receituário que não saiu é um tutor
 * na porta da farmácia agora, não amanhã.
 */

export const { startJobs, stopJobs, runJobNow } = createJobScheduler({
  service: 'medical-record-service',
  logger,
  recordMetric,
  isDisabled: () => loadEnv().DISABLE_JOBS,
  jobs: [
    {
      name: 'record.retry-prescriptions',
      schedule: '*/10 * * * *',
      timeoutMs: 5 * 60_000,
      run: (now) => retryPendingPrescriptions(now),
    },
  ],
})
