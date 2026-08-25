import { getPrisma, setDbLogger } from '@petshop/db'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import { registerCatalogRoutes } from './modules/catalog/routes.js'
import { setAppointmentsPort } from './modules/catalog/port.js'
import { livePort as liveBillingPort } from './modules/scheduling/billing-port.js'
import { setBillingPort } from './modules/scheduling/gates.js'
import { livePort } from './modules/scheduling/port-impl.js'
import { registerSchedulingRoutes } from './modules/scheduling/routes.js'

/**
 * Fábrica do app, separada do `server.ts` para que os testes montem a aplicação
 * inteira — com hooks, handler de erro, RLS e rotas reais — sem abrir porta de rede.
 *
 * As duas portas são ligadas aqui. `setAppointmentsPort`: os módulos do catálogo
 * continuam sem saber que `appointments` existe, e as três regras da fatia 1 que
 * respondiam "nenhum" passam a responder de verdade. `setBillingPort`: o gate de
 * crédito passa a ler o limite real do MOD-LEDGER em vez do padrão nulo.
 *
 * Nos dois casos, nenhuma linha da regra mudou — só quem responde a pergunta.
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
  // RN-11 ligado ao MOD-LEDGER: o limite de crédito que o petshop configura passa a
  // valer de verdade. Até aqui a porta devolvia limite nulo, e nada bloqueava.
  setBillingPort(liveBillingPort)

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
