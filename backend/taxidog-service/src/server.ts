import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { startJobs, stopJobs } from './jobs/schedule.js'
import { startTaxiConsumers, stopTaxiConsumers } from './modules/taxi/consumers.js'

/** Entrypoint do taxidog-service (porta 3008 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  // A volta do pet só é destravada por evento (RN-10) e as corridas só caem em
  // cascata por evento (RN-14). Sem os consumidores, o motorista sairia para buscar
  // um pet ainda molhado e as corridas de um agendamento cancelado ficariam de pé.
  // Falha de broker não derruba o serviço — a função loga e segue.
  await startTaxiConsumers()
  startJobs()

  await app.listen({ port: env.TAXIDOG_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.TAXIDOG_SERVICE_PORT }, 'taxidog-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando taxidog-service')
    await app.close()
    await Promise.all([
      stopTaxiConsumers(),
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
  logger.fatal({ err: error }, 'falha ao subir o taxidog-service')
  process.exit(1)
})
