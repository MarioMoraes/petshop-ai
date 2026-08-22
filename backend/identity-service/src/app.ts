import { getPrisma, setDbLogger } from '@petshop/db'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import { registerMeRoutes } from './modules/me/routes.js'
import { registerOnboardingRoutes } from './modules/onboarding/routes.js'
import { registerRbacRoutes } from './modules/rbac/routes.js'
import { registerSettingsRoutes } from './modules/settings/routes.js'
import { registerTenantRoutes } from './modules/tenants/routes.js'

/**
 * Fábrica do app, separada do `server.ts` para que os testes montem a aplicação
 * inteira — com hooks, handler de erro e rotas reais — sem abrir porta de rede.
 */

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    // Correlaciona log de banco, de requisição e o traceId do problem+json.
    genReqId: (request) => (request.headers['x-request-id'] as string) ?? randomUUID(),
    trustProxy: true,
  })

  // Os logs de RLS saem correlacionados com os do serviço.
  setDbLogger({ error: (payload, message) => logger.error(payload, message) })

  registerErrorHandler(app)
  registerAuthContext(app)

  app.get('/health', async () => ({ status: 'ok', service: 'identity-service' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  await registerTenantRoutes(app)
  await registerOnboardingRoutes(app)
  await registerSettingsRoutes(app)
  await registerRbacRoutes(app)
  await registerMeRoutes(app)

  return app
}
