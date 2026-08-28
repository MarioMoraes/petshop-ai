import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { startJobs, stopJobs } from './jobs/schedule.js'

/** Entrypoint do messaging-service (porta 3010 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  // Sem o agendador, a fila enche e nada sai: este serviço é o único do sistema cujo
  // trabalho principal acontece **fora** de uma requisição.
  startJobs()

  await app.listen({ port: env.MESSAGING_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.MESSAGING_SERVICE_PORT }, 'messaging-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando messaging-service')
    await app.close()
    await Promise.all([stopJobs(), closeEvents(), closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o messaging-service')
  process.exit(1)
})
