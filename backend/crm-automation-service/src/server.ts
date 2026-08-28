import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { logger } from './lib/logger.js'
import { startJobs, stopJobs } from './jobs/schedule.js'
import { startCrmConsumers, stopCrmConsumers } from './modules/crm/consumers.js'

/** Entrypoint do crm-automation-service (porta 3009 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  // Os dois caminhos do módulo: o consumidor faz a reação imediata (confirmação,
  // cancelamento) e o job faz a rede de proteção (lembrete). Ver a nota em
  // `consumers.ts` sobre por que um não substitui o outro.
  await startCrmConsumers()
  startJobs()

  await app.listen({ port: env.CRM_AUTOMATION_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.CRM_AUTOMATION_SERVICE_PORT }, 'crm-automation-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando crm-automation-service')
    await app.close()
    await Promise.all([stopCrmConsumers(), stopJobs(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o crm-automation-service')
  process.exit(1)
})
