import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { startJobs, stopJobs } from './jobs/schedule.js'
import { startSiteConsumers, stopSiteConsumers } from './modules/site/consumers.js'

/** Entrypoint do tenant-site-service (porta 3013 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  // Sem os consumidores, o horário corrigido no Admin às 9h aparece na página ao
  // meio-dia — e a promessa do template alimentado por dados vira mentira. Falha de
  // broker não derruba o serviço: a página ainda se atualiza pelo TTL de 10 minutos.
  await startSiteConsumers()
  startJobs()

  await app.listen({ port: env.SITE_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.SITE_SERVICE_PORT }, 'tenant-site-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando tenant-site-service')
    await app.close()
    await Promise.all([
      stopSiteConsumers(),
      stopJobs(),
      closeEvents(),
      closeRedis(),
      disconnectPrisma(),
    ])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o tenant-site-service')
  process.exit(1)
})
