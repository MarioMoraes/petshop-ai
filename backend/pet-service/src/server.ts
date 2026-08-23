import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { startPetConsumers, stopPetConsumers } from './modules/pets/consumers.js'

/** Entrypoint do pet-service (porta 3004 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  await startPetConsumers()

  await app.listen({ port: env.PET_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.PET_SERVICE_PORT }, 'pet-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando pet-service')
    await stopPetConsumers()
    await app.close()
    await Promise.all([closeEvents(), closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o pet-service')
  process.exit(1)
})
