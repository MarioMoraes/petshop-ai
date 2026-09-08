import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { getPrisma, setDbLogger } from '@petshop/db'
import { verifyServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import { AppError, MAX_PHOTOS_PER_UPLOAD, MAX_PHOTO_BYTES } from '@petshop/shared-types'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { InvalidTokenError, verifySessionToken } from './auth/clerk-token.js'
import { resolvePortalSession, resolvePortalTenant } from './auth/portal-session.js'
import { resolveSession } from './auth/session.js'
import { listFromEnv, loadEnv } from './config/env.js'
import { registerModules } from './gateway/routes.js'
import { registerErrorHandler } from './shared/errors.js'
import { logger, loggerOptions } from './shared/logger.js'
import { isPortalPath, proxyRequest, resolveTarget } from './proxy.js'

/**
 * O backend (porta 3000, SPEC §2).
 *
 * Ponto único de entrada: valida o token do Clerk, resolve tenant e permissões,
 * aplica rate limit e o gate de tenant suspenso. O que já é módulo deste processo é
 * atendido aqui mesmo; o que ainda não migrou segue ao serviço com o contexto
 * assinado.
 */

const PUBLIC_PATHS = new Set(['/health', '/ready'])

/**
 * A superfície anônima dos módulos.
 *
 * O prefixo é a fronteira, e é dela que depende o site do estabelecimento responder a
 * quem nunca se identificou. Vale para **prefixo inteiro**, então uma rota nova sob
 * `/public/` nasce aberta — é o preço de ter a fronteira legível, e a razão de o
 * escopo autenticado de `gateway/routes.ts` ser o padrão e este a exceção declarada.
 */
const PUBLIC_PREFIX = '/public/'

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
    /**
     * A superfície anônima fica **fora** deste balde, e a razão é o formato do
     * tráfego: em produção quem chama `/public/` é sempre o servidor do Next, pela
     * rede interna, com um IP só. Um balde por IP juntaria o site de todos os tenants
     * num teto comum — e um visitante abusivo derrubaria a página dos outros.
     *
     * Quem defende essa superfície é o módulo, com o recorte certo: leitura fica em
     * cache no Next (dez minutos a página, uma hora a foto), e o envio do formulário,
     * único caminho anônimo de escrita, tem teto por tenant **e por IP do visitante** —
     * que é o IP que a Server Action repassa, não o do container.
     */
    allowList: (request: FastifyRequest) =>
      (request.url.split('?')[0] ?? '').startsWith(PUBLIC_PREFIX),
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
    if (PUBLIC_PATHS.has(path) || path.startsWith(PUBLIC_PREFIX)) return
    if (request.method === 'OPTIONS') return

    const internal = resolveInternalRequest(request)
    const context = internal
      ? internal
      : isPortalPath(path)
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

  app.get('/health', async () => ({ status: 'ok', service: 'petshop-app' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch (error) {
      logger.error({ err: error }, 'readiness falhou')
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  await registerModules(app)

  /**
   * O encaminhamento aos serviços que ainda não migraram, **num escopo próprio**.
   *
   * O escopo existe pelo parser: aqui `multipart/form-data` é bufferizado byte a byte
   * e repassado intacto (MOD-PET-04 — o `boundary` está no `content-type`, e
   * reserializar corromperia o arquivo), enquanto o módulo do site precisa do parser
   * de verdade para consumir o upload da galeria. Os dois não cabem na raiz: o
   * Fastify recusa um segundo parser para o mesmo content-type e o processo nem sobe
   * (`FST_ERR_CTP_ALREADY_PRESENT`). Em escopos irmãos, cada um vale no seu ramo.
   *
   * O teto é o do arquivo mais folga para o envelope multipart e os metadados; quem
   * recusa de verdade, com a mensagem do AC-02, é o pet-service.
   */
  await app.register(async (proxy) => {
    proxy.addContentTypeParser(
      'multipart/form-data',
      { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES * MAX_PHOTOS_PER_UPLOAD + 1_048_576 },
      (_request, body, done) => {
        done(null, body)
      },
    )

    // Métodos explícitos, e não `proxy.all`: o @fastify/cors já registra o handler de
    // preflight em OPTIONS `/*`, e um `all` colidiria com ele.
    proxy.route({
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
  })

  return app
}

/**
 * A requisição de um serviço que **ainda não migrou**, autenticada pela assinatura.
 *
 * Enquanto a consolidação está em curso, o processo tem duas portas de entrada. Pela
 * de fora chega o token do Clerk, que este arquivo resolve em contexto. Pela de dentro
 * chega um serviço que já tem o contexto resolvido e o assina com HMAC — é o contrato
 * gateway→serviço de sempre, e é assim que o `portal-bff` alcança o Taxi Dog agora que
 * o Taxi Dog não tem porta própria (MOD-PORTAL-07).
 *
 * **Não afrouxa nada.** Assinar exige o `INTERNAL_SERVICE_SECRET`, e o gateway já
 * descarta os headers `x-petshop-*` que chegam de fora antes de encaminhar, então um
 * cliente não consegue se apresentar por aqui. O que a assinatura prova é o mesmo que
 * provava quando o destino era outro processo.
 *
 * **Some com a última fatia.** Quando nenhum serviço sobrar, não há mais quem assine,
 * e esta função sai junto com o `proxy.ts`.
 */
function resolveInternalRequest(request: FastifyRequest): ServiceAuthContext | null {
  const result = verifyServiceHeaders(request.headers, loadEnv().INTERNAL_SERVICE_SECRET)
  if (result.ok) return result.context

  // Sem assinatura nenhuma é o caso normal: a requisição veio de fora, com token.
  if (result.reason === 'MISSING_SIGNATURE') return null

  // Assinatura presente e inválida é outra coisa — relógio fora de hora, segredo
  // divergente entre serviços, ou tentativa de forjar. Nenhuma delas deve virar
  // silenciosamente uma tentativa de ler token que não existe.
  request.log.warn({ reason: result.reason, path: request.url }, 'assinatura de serviço inválida')
  throw new AppError('ERR_IDENT_005', 'Requisição não autenticada')
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
