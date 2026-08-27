import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../env.js'
import { logger, recordMetric } from '../lib/logger.js'
import {
  alertUnassignedRides,
  measureWindowAdherence,
  sweepOverdueRides,
} from '../modules/taxi/jobs.js'

/**
 * A grade do Taxi Dog.
 *
 * Os dois primeiros rodam durante o expediente porque operam sobre o dia que está
 * acontecendo: descobrir de manhã que a van de ontem não saiu não serve para nada.
 * A aderência à janela é fechamento, e espera a madrugada.
 *
 * Nenhum deles **muda** uma corrida — todos só relatam. Ver a nota em
 * `modules/taxi/jobs.ts` sobre por que a agenda pode marcar no-show sozinha e o Taxi
 * Dog não pode marcar falha.
 */

export const { startJobs, stopJobs, runJobNow } = createJobScheduler({
  service: 'taxidog-service',
  logger,
  recordMetric,
  isDisabled: () => loadEnv().DISABLE_JOBS,
  jobs: [
    {
      // Meia hora é o passo certo para um alerta cujo horizonte é de 12 horas:
      // varrer de 5 em 5 minutos não adiantaria a decisão em nada.
      name: 'taxi.unassigned-alert',
      schedule: '*/30 * * * *',
      run: (now) => alertUnassignedRides(now),
    },
    {
      name: 'taxi.overdue-sweeper',
      schedule: '*/15 * * * *',
      run: (now) => sweepOverdueRides(now),
    },
    {
      name: 'taxi.window-adherence',
      schedule: '15 4 * * *',
      run: (now) => measureWindowAdherence(now),
    },
  ],
})
