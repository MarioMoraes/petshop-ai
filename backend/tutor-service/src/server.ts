import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { startTutorConsumers, stopTutorConsumers } from './modules/tutors/consumers.js'

/** Entrypoint do tutor-service (porta 3003 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  await startTutorConsumers()

  await app.listen({ port: env.TUTOR_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.TUTOR_SERVICE_PORT }, 'tutor-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando tutor-service')
    await stopTutorConsumers()
    await app.close()
    await Promise.all([closeEvents(), closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o tutor-service')
  process.exit(1)
})
