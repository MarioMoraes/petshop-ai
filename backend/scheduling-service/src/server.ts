import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import {
  startSchedulingConsumers,
  stopSchedulingConsumers,
} from './modules/scheduling/consumers.js'

/** Entrypoint do scheduling-service (porta 3006 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  await startSchedulingConsumers()
  await app.listen({ port: env.SCHEDULING_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.SCHEDULING_SERVICE_PORT }, 'scheduling-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando scheduling-service')
    await app.close()
    await Promise.all([
      stopSchedulingConsumers(),
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
  logger.fatal({ err: error }, 'falha ao subir o scheduling-service')
  process.exit(1)
})
