import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'

/** Entrypoint do api-gateway (porta 3000, SPEC §2). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  await app.listen({ port: env.GATEWAY_PORT, host: '0.0.0.0' })
  logger.info({ port: env.GATEWAY_PORT }, 'api-gateway no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando api-gateway')
    await app.close()
    await Promise.all([closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o api-gateway')
  process.exit(1)
})
