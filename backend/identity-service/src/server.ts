import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { startJobs, stopJobs } from './jobs/schedule.js'

/** Entrypoint do identity-service (porta 3001, SPEC §2). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  startJobs()

  await app.listen({ port: env.IDENTITY_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.IDENTITY_SERVICE_PORT }, 'identity-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando identity-service')
    await app.close()
    // Espera o retry em curso: cortá-lo no meio deixaria o tenant sem Organization no
    // Clerk e com a tentativa já contada.
    await stopJobs()
    await Promise.all([closeEvents(), closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o identity-service')
  process.exit(1)
})
