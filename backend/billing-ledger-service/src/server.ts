import { disconnectPrisma } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './env.js'
import { closeEvents } from './lib/events.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { startJobs, stopJobs } from './jobs/schedule.js'
import { startLedgerConsumers, stopLedgerConsumers } from './modules/ledger/consumers.js'

/** Entrypoint do billing-ledger-service (porta 3007 — ver a nota em `env.ts`). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  await startLedgerConsumers()
  startJobs()
  await app.listen({ port: env.BILLING_LEDGER_SERVICE_PORT, host: '0.0.0.0' })
  logger.info({ port: env.BILLING_LEDGER_SERVICE_PORT }, 'billing-ledger-service no ar')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando billing-ledger-service')
    await app.close()
    // `stopJobs` primeiro e sozinho: ele **espera** o job em curso terminar, e o
    // `process.exit` logo abaixo não dá segunda chance a quem estiver no meio de uma
    // varredura.
    await stopJobs()
    await Promise.all([stopLedgerConsumers(), closeEvents(), closeRedis(), disconnectPrisma()])
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'falha ao subir o billing-ledger-service')
  process.exit(1)
})
