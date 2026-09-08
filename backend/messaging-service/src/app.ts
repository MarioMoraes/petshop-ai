import { getPrisma, setDbLogger } from '@petshop/db'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import {
  registerEmailWebhookRoutes,
  registerMessagingRoutes,
  registerWhatsappWebhookRoutes,
} from './modules/messaging/routes.js'

/**
 * Fábrica do app, separada do `server.ts` para que os testes montem a aplicação
 * inteira — com hooks, handler de erro, RLS e rotas reais — sem abrir porta de rede.
 */

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: (request) => (request.headers['x-request-id'] as string) ?? randomUUID(),
    trustProxy: true,
  })

  setDbLogger({ error: (payload, message) => logger.error(payload, message) })

  registerErrorHandler(app)

  app.get('/health', async () => ({ status: 'ok', service: 'messaging-service' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  // Anônimo: o callback da Evolution não conhece o contrato HMAC do gateway. Quem o
  // autentica é o token da instância, e é por isso que ele fica **fora** do escopo
  // autenticado — o mesmo desenho que o `tenant-site-service` usa para a página pública.
  await app.register(registerWhatsappWebhookRoutes)

  // O do Resend, pela mesma razão e com uma diferença: ele precisa do corpo **cru**
  // para conferir a assinatura, e por isso registra um parser próprio no escopo dele.
  await app.register(registerEmailWebhookRoutes)

  // Autenticada: a assinatura do gateway vale só dentro deste escopo.
  await app.register(async (authenticated) => {
    registerAuthContext(authenticated)
    await registerMessagingRoutes(authenticated)
  })

  return app
}
