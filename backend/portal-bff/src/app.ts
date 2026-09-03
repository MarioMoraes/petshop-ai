import { randomUUID } from 'node:crypto'
import { getPrisma, setDbLogger } from '@petshop/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import { registerPortalRoutes, registerPublicPortalRoutes } from './modules/portal/routes.js'

/**
 * Fábrica do app, separada do `server.ts` para que os testes montem a aplicação inteira
 * — hooks, handler de erro, RLS e rotas reais — sem abrir porta de rede.
 *
 * **A separação das duas superfícies acontece aqui**, no molde do tenant-site-service: o
 * hook que exige a assinatura do gateway é registrado num escopo do Fastify que contém
 * apenas as rotas autenticadas; a pública fica de fora dele.
 *
 * A diferença para o site é o que "pública" significa nos dois: lá, quem chega é
 * anônimo de verdade; aqui, só a identidade visual do petshop responde sem sessão, e
 * todo o resto exige o contexto assinado — inclusive o pedido de código, que é a porta
 * de entrada e não o balcão aberto.
 */

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: (request) => (request.headers['x-request-id'] as string) ?? randomUUID(),
    trustProxy: true,
  })

  setDbLogger({ error: (payload, message) => logger.error(payload, message) })

  registerErrorHandler(app)

  app.get('/health', async () => ({ status: 'ok', service: 'portal-bff' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  // O tenant já vem do gateway, resolvido pelo host. Sem usuário, sem permissões.
  await app.register(async (publicScope) => {
    registerAuthContext(publicScope)
    await registerPublicPortalRoutes(publicScope)
  })

  await app.register(async (authenticated) => {
    registerAuthContext(authenticated)
    await registerPortalRoutes(authenticated)
  })

  return app
}
