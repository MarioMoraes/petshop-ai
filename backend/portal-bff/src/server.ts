import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'

/** Entrypoint do portal-bff (porta 3020 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  await app.listen({ port: env.PORTAL_BFF_PORT, host: '0.0.0.0' })
  logger.info({ port: env.PORTAL_BFF_PORT }, 'portal-bff no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando portal-bff')
    await app.close()
    await Promise.all([closeEvents(), closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o portal-bff')
  process.exit(1)
})
