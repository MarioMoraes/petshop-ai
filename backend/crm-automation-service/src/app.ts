import { getPrisma, setDbLogger } from '@petshop/db'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import { registerCrmRoutes } from './modules/crm/routes.js'

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
  registerAuthContext(app)

  app.get('/health', async () => ({ status: 'ok', service: 'crm-automation-service' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  await registerCrmRoutes(app)

  return app
}
