import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../config/env.js'
import { logger, recordMetric } from '../shared/logger.js'
import { crmConsumer } from '../modules/crm/consumers.js'
import { ledgerConsumer } from '../modules/ledger/consumers.js'
import { petConsumer } from '../modules/pets/consumers.js'
import { recordConsumer } from '../modules/attendances/consumers.js'
import { schedulingConsumer } from '../modules/scheduling/consumers.js'
import { tutorConsumer } from '../modules/tutors/consumers.js'
import { siteConsumer } from '../modules/site/consumers.js'
import { taxiConsumer } from '../modules/taxi/consumers.js'
import { startEventConsumers, stopEventConsumers } from '../shared/event-consumer.js'
import { agentJobs } from './agent-jobs.js'
import { crmJobs } from './crm-jobs.js'
import { identityJobs } from './identity-jobs.js'
import { inventoryJobs } from './inventory-jobs.js'
import { recordJobs } from './record-jobs.js'
import { ledgerJobs } from './ledger-jobs.js'
import { schedulingJobs } from './scheduling-jobs.js'
import { securityJobs } from './security-jobs.js'
import { messagingJobs } from './messaging-jobs.js'
import { platformJobs } from './platform-jobs.js'
import { siteJobs } from './site-jobs.js'
import { subscriptionJobs } from './subscription-jobs.js'
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

export const { startJobs, stopJobs, runJobNow, describeJobs } = createJobScheduler({
  service: 'petshop-app',
  logger,
  recordMetric,
  isDisabled: () => loadEnv().DISABLE_JOBS,
  jobs: [
    ...siteJobs,
    ...taxiJobs,
    ...crmJobs,
    ...messagingJobs,
    ...agentJobs,
    ...tutorJobs,
    ...identityJobs,
    ...securityJobs,
    ...recordJobs,
    ...schedulingJobs,
    ...ledgerJobs,
    ...platformJobs,
    ...subscriptionJobs,
    ...inventoryJobs,
  ],
})

const CONSUMERS = [
  siteConsumer,
  taxiConsumer,
  crmConsumer,
  petConsumer,
  tutorConsumer,
  recordConsumer,
  schedulingConsumer,
  ledgerConsumer,
]

/**
 * Liga os consumidores de evento dos módulos (o mecanismo é `shared/event-consumer.ts`).
 *
 * Falha de broker não derruba o processo: sem os consumidores do site, o horário
 * corrigido no Admin às 9h só aparece na página quando o TTL de 10 minutos vencer —
 * degradado, não indisponível. E o broker que volta é reencontrado sozinho.
 */
export function startConsumers(): Promise<void> {
  return startEventConsumers(CONSUMERS)
}

export function stopConsumers(): Promise<void> {
  return stopEventConsumers()
}
