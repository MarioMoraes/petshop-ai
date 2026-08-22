import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { getPrisma, setDbLogger } from '@petshop/db'
import { AppError, toProblemDetails } from '@petshop/shared-types'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { InvalidTokenError, verifySessionToken } from './auth/clerk-token.js'
import { resolveSession } from './auth/session.js'
import { listFromEnv, loadEnv } from './env.js'
import { logger, loggerOptions } from './lib/logger.js'
import { proxyRequest, resolveTarget } from './proxy.js'

/**
 * api-gateway (porta 3000, SPEC §2).
 *
 * Ponto único de entrada: valida o token do Clerk, resolve tenant e permissões,
 * aplica rate limit e o gate de tenant suspenso, e encaminha aos serviços com o
 * contexto assinado.
 */

const PROBLEM_CONTENT_TYPE = 'application/problem+json'
const PUBLIC_PATHS = new Set(['/health', '/ready'])

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv()

  const app = Fastify({
    logger: loggerOptions,
    genReqId: (request) => (request.headers['x-request-id'] as string) ?? randomUUID(),
    trustProxy: true,
  })

  setDbLogger({ error: (payload, message) => logger.error(payload, message) })

  // SPEC §7.4 — CORS restritivo por domínio, nunca `*` com credenciais.
  await app.register(cors, {
    origin: listFromEnv(env.CORS_ORIGINS),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  })

  // SPEC §7.3 — rate limit por IP e por tenant/usuário.
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request: FastifyRequest) => {
      const tenantId = request.authContext?.tenantId
      const userId = request.authContext?.clerkUserId
      return tenantId && userId ? `${tenantId}:${userId}` : request.ip
    },
  })

  registerErrorHandler(app)

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const path = request.url.split('?')[0] ?? ''
    if (PUBLIC_PATHS.has(path) || request.method === 'OPTIONS') return

    const token = readBearerToken(request)
    if (!token) throw new AppError('ERR_IDENT_005', 'Autenticação obrigatória')

    let claims
    try {
      claims = await verifySessionToken(token)
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        request.log.warn({ reason: error.message, path }, 'token de sessão inválido')
        throw new AppError('ERR_IDENT_005', 'Sessão inválida ou expirada')
      }
      throw error
    }

    const { context } = await resolveSession(claims, request.method)
    request.authContext = context

    // Correlação por tenant, exigida pelo SPEC §8.
    request.log = request.log.child({
      tenantId: context.tenantId ?? null,
      userId: context.userId ?? null,
    })
  })

  app.get('/health', async () => ({ status: 'ok', service: 'api-gateway' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  // Métodos explícitos, e não `app.all`: o @fastify/cors já registra o handler de
  // preflight em OPTIONS `/*`, e um `all` colidiria com ele.
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/*',
    handler: async (request, reply) => {
      const path = request.url.split('?')[0] ?? ''
      const target = resolveTarget(path)
      if (!target) {
        throw new AppError('ERR_IDENT_001', 'Rota não encontrada')
      }
      return proxyRequest(request, reply, {
        targetBaseUrl: target,
        context: request.authContext,
      })
    },
  })

  return app
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = String(request.id)

    if (error instanceof AppError) {
      request.log.info({ traceId, code: error.code, path: request.url }, error.message)
      return reply
        .status(error.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(toProblemDetails(error, traceId))
    }

    // O plugin de rate limit sinaliza pelo status, não por um tipo próprio.
    if ((error as { statusCode?: number })?.statusCode === 429) {
      return reply.status(429).type(PROBLEM_CONTENT_TYPE).send({
        type: 'https://docs.petshopai.com/errors/ERR_RATE_LIMITED',
        title: 'Muitas requisições',
        status: 429,
        code: 'ERR_RATE_LIMITED',
        detail: 'Você fez muitas requisições. Aguarde um instante.',
        traceId,
      })
    }

    logger.error({ traceId, err: error, path: request.url }, 'erro não tratado no gateway')
    return reply.status(500).type(PROBLEM_CONTENT_TYPE).send({
      type: 'https://docs.petshopai.com/errors/ERR_INTERNAL',
      title: 'Erro interno',
      status: 500,
      code: 'ERR_INTERNAL',
      detail: 'Não foi possível concluir a operação. Tente novamente.',
      traceId,
    })
  })
}
