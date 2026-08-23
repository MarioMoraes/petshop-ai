import { getPrisma, setDbLogger } from '@petshop/db'
import { randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import { MAX_PHOTOS_PER_UPLOAD, MAX_PHOTO_BYTES } from '@petshop/shared-types'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from './auth/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { logger, loggerOptions } from './lib/logger.js'
import { registerCatalogRoutes } from './modules/catalog/routes.js'
import { registerPetRoutes } from './modules/pets/routes.js'
import { registerPhotoRoutes } from './modules/photos/routes.js'

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

  // MOD-PET-04. Os limites são a primeira barreira do AC-02: o arquivo de 40 MB é
  // recusado no parser, antes de ocupar memória do processo.
  await app.register(multipart, {
    limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_UPLOAD, fieldSize: 4096 },
  })

  registerErrorHandler(app)
  registerAuthContext(app)

  app.get('/health', async () => ({ status: 'ok', service: 'pet-service' }))

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
  await registerPetRoutes(app)
  await registerPhotoRoutes(app)

  return app
}
