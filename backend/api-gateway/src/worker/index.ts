import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../config/env.js'
import { logger, recordMetric } from '../shared/logger.js'
import { startCrmConsumers, stopCrmConsumers } from '../modules/crm/consumers.js'
import { startPetConsumers, stopPetConsumers } from '../modules/pets/consumers.js'
import { startRecordConsumers, stopRecordConsumers } from '../modules/attendances/consumers.js'
import { startTutorConsumers, stopTutorConsumers } from '../modules/tutors/consumers.js'
import { startSiteConsumers, stopSiteConsumers } from '../modules/site/consumers.js'
import { startTaxiConsumers, stopTaxiConsumers } from '../modules/taxi/consumers.js'
import { crmJobs } from './crm-jobs.js'
import { identityJobs } from './identity-jobs.js'
import { recordJobs } from './record-jobs.js'
import { securityJobs } from './security-jobs.js'
import { messagingJobs } from './messaging-jobs.js'
import { siteJobs } from './site-jobs.js'
import { tutorJobs } from './tutor-jobs.js'
import { taxiJobs } from './taxi-jobs.js'

/**
 * O trabalho de fundo do processo: consumidores de evento e grade de jobs.
 *
 * **Um agendador só, com os jobs de todos os módulos.** O que dá exclusão mútua entre
 * réplicas é o lease, e o lease é por **nome do job** (`job_leases.name`), não por
 * serviço — juntar as grades num agendador só não muda quem roda o quê. O nome de cada
 * job continua idêntico ao que era, que é o que preserva o histórico em `job_runs` e o
 * lease de quem estiver no ar durante um deploy.
 *
 * Cada fatia da consolidação acrescenta aqui os seus consumidores e o seu array de
 * jobs.
 */

export const { startJobs, stopJobs, runJobNow } = createJobScheduler({
  service: 'petshop-app',
  logger,
  recordMetric,
  isDisabled: () => loadEnv().DISABLE_JOBS,
  jobs: [
    ...siteJobs,
    ...taxiJobs,
    ...crmJobs,
    ...messagingJobs,
    ...tutorJobs,
    ...identityJobs,
    ...securityJobs,
    ...recordJobs,
  ],
})

/**
 * Liga os consumidores de evento dos módulos.
 *
 * Falha de broker não derruba o processo: sem os consumidores do site, o horário
 * corrigido no Admin às 9h só aparece na página quando o TTL de 10 minutos vencer —
 * degradado, não indisponível.
 */
export async function startConsumers(): Promise<void> {
  await startSiteConsumers()
  await startTaxiConsumers()
  await startCrmConsumers()
  await startPetConsumers()
  await startTutorConsumers()
  await startRecordConsumers()
}

export async function stopConsumers(): Promise<void> {
  await Promise.all([
    stopSiteConsumers(),
    stopTaxiConsumers(),
    stopCrmConsumers(),
    stopPetConsumers(),
    stopTutorConsumers(),
    stopRecordConsumers(),
  ])
}
