import { getPrisma, setDbLogger } from '@petshop/db'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import { registerCatalogRoutes } from './modules/catalog/routes.js'
import { setAppointmentsPort } from './modules/catalog/port.js'
import { livePort } from './modules/scheduling/port-impl.js'
import { registerSchedulingRoutes } from './modules/scheduling/routes.js'

/**
 * Fábrica do app, separada do `server.ts` para que os testes montem a aplicação
 * inteira — com hooks, handler de erro, RLS e rotas reais — sem abrir porta de rede.
 *
 * `setAppointmentsPort` é chamado aqui: os módulos do catálogo continuam sem saber
 * que `appointments` existe, e as três regras da fatia 1 que respondiam "nenhum"
 * passam a responder de verdade — sem que uma linha delas tenha mudado.
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

  setAppointmentsPort(livePort)

  app.get('/health', async () => ({ status: 'ok', service: 'scheduling-service' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  await registerCatalogRoutes(app)
  await registerSchedulingRoutes(app)

  return app
}
