import { disconnectPrisma, hashEmail } from '@petshop/db'
import { buildApp } from './app.js'
import { loadEnv } from './config/env.js'
import { closeEvents } from './shared/events.js'
import { logger } from './shared/logger.js'
import { bootstrapPlatformAdmin } from './modules/platform/service.js'
import { closeRedis } from './shared/redis.js'
import { startConsumers, startJobs, stopConsumers, stopJobs } from './worker/index.js'

/** Entrypoint do backend (porta 3000, SPEC §2). */

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  /**
   * O primeiro administrador de plataforma, se `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` disser
   * quem é e a tabela estiver vazia (AC-06 de MOD-ADMIN-01).
   *
   * Antes de aceitar requisição, e não depois: a superfície `/platform/v1` responde 404 a
   * quem não é da plataforma, e subir sem administrador nenhum a deixa inalcançável para
   * todo mundo. Falhar aqui **não** derruba o processo — um bootstrap que não achou a
   * pessoa é um aviso no log, e o backend do petshop segue no ar.
   */
  await bootstrapPlatformAdmin(env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL
    ? hashEmail(env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL)
    : null).catch((error: unknown) => {
    logger.error({ err: error }, 'falha no bootstrap do administrador de plataforma')
  })

  await startConsumers()
  startJobs()

  await app.listen({ port: env.GATEWAY_PORT, host: '0.0.0.0' })
  logger.info({ port: env.GATEWAY_PORT }, 'backend no ar')

  /**
   * A ordem importa: o app fecha **antes** do trabalho de fundo.
   *
   * Fechar o Fastify primeiro faz o processo parar de aceitar requisição nova e
   * terminar as que já estavam em voo. Só então os consumidores devolvem o que
   * estiverem processando, o agendador solta o lease e as conexões caem. Ao contrário,
   * uma requisição em voo encontraria o Redis já fechado.
   */
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando backend')
    await app.close()
    await Promise.all([
      stopConsumers(),
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
  logger.fatal({ err: error }, 'falha ao subir o backend')
  process.exit(1)
})
