import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'

/** Entrypoint do medical-record-service (porta 3005 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  await app.listen({ port: env.MEDICAL_RECORD_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.MEDICAL_RECORD_SERVICE_PORT }, 'medical-record-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando medical-record-service')
    await app.close()
    await Promise.all([closeEvents(), closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o medical-record-service')
  process.exit(1)
})
