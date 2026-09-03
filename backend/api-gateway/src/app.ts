import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { getPrisma, setDbLogger } from '@petshop/db'
import {
  AppError,
  MAX_PHOTOS_PER_UPLOAD,
  MAX_PHOTO_BYTES,
  toProblemDetails,
} from '@petshop/shared-types'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { InvalidTokenError, verifySessionToken } from './auth/clerk-token.js'
import { resolvePortalSession, resolvePortalTenant } from './auth/portal-session.js'
import { resolveSession } from './auth/session.js'
import { listFromEnv, loadEnv } from './env.js'
import { logger, loggerOptions } from './lib/logger.js'
import { isPortalPath, proxyRequest, resolveTarget } from './proxy.js'

/**
 * api-gateway (porta 3000, SPEC §2).
 *
 * Ponto único de entrada: valida o token do Clerk, resolve tenant e permissões,
 * aplica rate limit e o gate de tenant suspenso, e encaminha aos serviços com o
 * contexto assinado.
 */

const PROBLEM_CONTENT_TYPE = 'application/problem+json'
const PUBLIC_PATHS = new Set(['/health', '/ready'])

/**
 * O header pelo qual o Next diz de que petshop o Portal está falando.
 *
 * O tutor não tem Organization no Clerk, então o tenant **não** pode sair do token: sai
 * do host que o Next serviu (`{slug}.{APP_DOMAIN}`), e o Next o repassa aqui. Forjá-lo
 * não leva a lugar nenhum — o contexto resultante só tem `tutorId` se o usuário tiver
 * ficha *naquele* tenant —, e o header é descartado antes de seguir ao serviço.
 */
const TENANT_SLUG_HEADER = 'x-petshop-tenant-slug'

/**
 * A única rota do Portal que responde sem sessão: a identidade visual que a tela de
 * login mostra. Não carrega dado de cliente nenhum.
 */
const PORTAL_PUBLIC_PATHS = new Set(['/portal/v1/tenant'])

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv()

  const app = Fastify({
    logger: loggerOptions,
    genReqId: (request) => (request.headers['x-request-id'] as string) ?? randomUUID(),
    trustProxy: true,
  })

  setDbLogger({ error: (payload, message) => logger.error(payload, message) })

  /**
   * Corpo binário passa direto (MOD-PET-04).
   *
   * O gateway não interpreta upload: ele bufferiza os bytes e repassa. Registrar o
   * `@fastify/multipart` aqui obrigaria a remontar o multipart do outro lado, com
   * outro `boundary` — trabalho para chegar ao mesmo lugar, e uma chance a mais de
   * corromper o arquivo no caminho.
   *
   * O teto é o do arquivo mais folga para o envelope multipart e os metadados; quem
   * recusa de verdade, com a mensagem do AC-02, é o pet-service.
   */
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES * MAX_PHOTOS_PER_UPLOAD + 1_048_576 },
    (_request, body, done) => {
      done(null, body)
    },
  )

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
      if (tenantId && userId) return `${tenantId}:${userId}`

      // Sem contexto resolvido, o balde é do IP — e no Portal, do IP **por petshop**.
      // Sem separar, o NAT de uma operadora esgotaria o balde de um tenant e barraria
      // os tutores de todos os outros junto.
      const slug = request.headers[TENANT_SLUG_HEADER]
      const tenantSlug = Array.isArray(slug) ? slug[0] : slug
      return tenantSlug ? `${tenantSlug}:${request.ip}` : request.ip
    },
  })

  registerErrorHandler(app)

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const path = request.url.split('?')[0] ?? ''
    if (PUBLIC_PATHS.has(path) || request.method === 'OPTIONS') return

    const context = isPortalPath(path)
      ? await resolvePortalRequest(request, path)
      : await resolveAdminRequest(request, path)

    request.authContext = context

    // Correlação por tenant, exigida pelo SPEC §8.
    request.log = request.log.child({
      tenantId: context.tenantId ?? null,
      userId: context.userId ?? null,
      tutorId: context.tutorId ?? null,
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

/**
 * A sessão da equipe, como sempre foi — mais uma guarda nova.
 *
 * **Contexto com `tutorId` nunca alcança `/v1`** (AC-04 de MOD-PORTAL-11). Hoje isso é
 * impossível por construção, porque só `resolvePortalRequest` monta contexto de tutor;
 * a checagem existe para o dia em que alguém unificar as duas resoluções "porque são
 * quase iguais" e não perceber que acabou de abrir o Admin para o cliente final.
 */
async function resolveAdminRequest(request: FastifyRequest, path: string) {
  const claims = await verifyBearer(request, path)
  const { context } = await resolveSession(claims, request.method)

  if (context.tutorId) {
    request.log.warn({ path, tutorId: context.tutorId }, 'sessão de tutor barrada fora do Portal')
    throw new AppError('ERR_PORTAL_008', 'Esta área é da equipe do estabelecimento')
  }

  return context
}

/**
 * A sessão do Portal (MOD-PORTAL-02).
 *
 * O slug vem do header, e não do token, porque o tutor não tem Organization. Sem o
 * header não há de que petshop falar: 404, e não 401 — quem não disse o endereço não
 * tem sessão a apresentar.
 */
async function resolvePortalRequest(request: FastifyRequest, path: string) {
  const raw = request.headers[TENANT_SLUG_HEADER]
  const slug = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? ''
  if (!slug) throw new AppError('ERR_PORTAL_001', 'Estabelecimento não informado')

  if (PORTAL_PUBLIC_PATHS.has(path)) {
    // A tela de login precisa do nome e da cor do petshop antes de haver sessão. O
    // contexto sai sem usuário: é o mínimo que o `portal-bff` precisa para saber de
    // quem é a página, e nada além disso.
    const tenant = await resolvePortalTenant(slug)
    return { clerkUserId: `anon:${slug}`, tenantId: tenant.id, permissions: [] }
  }

  const claims = await verifyBearer(request, path, portalAuthorizedParty(slug))
  const { context } = await resolvePortalSession(claims, slug)
  return context
}

/**
 * O `azp` que o token do Portal carrega: o host que o Next serviu.
 *
 * Em desenvolvimento o `APP_DOMAIN` é `localhost:3002` e não há subdomínio, então o
 * host de origem é o próprio domínio — o mesmo que o `CLERK_AUTHORIZED_PARTIES` já
 * lista, e o extra aqui é inofensivo.
 */
function portalAuthorizedParty(slug: string): string {
  const domain = loadEnv().APP_DOMAIN
  const protocol = domain.startsWith('localhost') ? 'http' : 'https'
  return domain.startsWith('localhost')
    ? `${protocol}://${domain}`
    : `${protocol}://${slug}.${domain}`
}

async function verifyBearer(
  request: FastifyRequest,
  path: string,
  extraAuthorizedParty?: string,
) {
  const token = readBearerToken(request)
  if (!token) throw new AppError('ERR_IDENT_005', 'Autenticação obrigatória')

  try {
    return await verifySessionToken(token, extraAuthorizedParty)
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      request.log.warn({ reason: error.message, path }, 'token de sessão inválido')
      throw new AppError('ERR_IDENT_005', 'Sessão inválida ou expirada')
    }
    throw error
  }
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
