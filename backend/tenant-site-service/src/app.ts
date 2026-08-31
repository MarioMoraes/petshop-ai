import { getPrisma, setDbLogger } from '@petshop/db'
import multipart from '@fastify/multipart'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { SITE_PHOTO_MAX_BYTES } from '@petshop/shared-types'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import { registerPublicSiteRoutes, registerSiteRoutes } from './modules/site/routes.js'

/**
 * Fábrica do app, separada do `server.ts` para que os testes montem a aplicação
 * inteira — com hooks, handler de erro, RLS e rotas reais — sem abrir porta de rede.
 *
 * **A separação das duas superfícies acontece aqui, e é a decisão de segurança do
 * serviço.** O hook que exige a assinatura do gateway é registrado dentro de um escopo
 * do Fastify que contém **apenas** as rotas administrativas; as públicas ficam de fora
 * dele. O efeito prático: não existe rota `/v1/site/*` sem autenticação por
 * esquecimento — ela precisaria ser registrada no escopo errado, o que se vê na
 * primeira leitura do arquivo. O contrário — uma rota pública que passasse a exigir
 * assinatura — deixaria o site fora do ar e apareceria no primeiro teste.
 */

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: (request) => (request.headers['x-request-id'] as string) ?? randomUUID(),
    trustProxy: true,
  })

  setDbLogger({ error: (payload, message) => logger.error(payload, message) })

  // O limite é a primeira barreira do upload: o arquivo grande demais é recusado no
  // parser, antes de ocupar memória do processo.
  await app.register(multipart, {
    limits: { fileSize: SITE_PHOTO_MAX_BYTES, files: 1, fieldSize: 4096 },
  })

  registerErrorHandler(app)

  app.get('/health', async () => ({ status: 'ok', service: 'tenant-site-service' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  // Anônima: o visitante não tem sessão, e o tenant vem do host resolvido pelo Next.
  await app.register(registerPublicSiteRoutes)

  // Autenticada: a assinatura do gateway vale só dentro deste escopo.
  await app.register(async (admin) => {
    registerAuthContext(admin)
    await registerSiteRoutes(admin)
  })

  return app
}
