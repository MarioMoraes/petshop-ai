import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { getPrisma, setDbLogger } from '@petshop/db'
import { SERVICE_HEADERS, type ServiceAuthContext } from '@petshop/service-auth'
import { AppError, ROLE_PERMISSIONS } from '@petshop/shared-types'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { InvalidTokenError, verifySessionToken, type SessionClaims } from './auth/clerk-token.js'
import { resolvePortalSession, resolvePortalTenant } from './auth/portal-session.js'
import { resolveSession } from './auth/session.js'
import { listFromEnv, loadEnv } from './config/env.js'
import { registerModules } from './gateway/routes.js'
import { isPlatformPath } from './modules/platform/routes.js'
import { resolvePlatformAdmin } from './modules/platform/service.js'
import { findActiveGrant, recordSupportRead } from './modules/platform/grants.js'
import {
  needsGrant,
  notFound as platformNotFound,
  readOnly,
} from './modules/platform/errors.js'
import { isPortalPath } from './modules/portal/routes.js'
import { registerErrorHandler } from './shared/errors.js'
import { recordSecurityEvent } from './shared/security-events.js'
import { logger, loggerOptions } from './shared/logger.js'

/**
 * O backend (porta 3000, SPEC §2).
 *
 * Ponto único de entrada: valida o token do Clerk, resolve tenant e permissões, aplica
 * rate limit e o gate de tenant suspenso. **Tudo o que ele atende é módulo deste
 * processo** — a consolidação fechou na fatia 11, e com ela saíram o `proxy.ts` e a porta
 * interna assinada em HMAC.
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
 * As superfícies de webhook dos módulos.
 *
 * Aqui não chega token do Clerk nem assinatura nossa: quem bate são provedores de
 * fora (a Evolution no pareamento do WhatsApp, o Resend no retorno de entrega). Cada
 * rota se autentica sozinha, com o token da instância ou com a assinatura Svix sobre
 * o corpo cru — e é por isso que elas ficam fora do hook de sessão, não porque sejam
 * menos sensíveis.
 *
 * O nome `/internal/` diz de onde a chamada nasce, não que ela seja privada: a rota do
 * Resend é a **única** superfície de backend que a borda publica (ver
 * `infra/Caddyfile`).
 */
const WEBHOOK_PREFIX = '/internal/'

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
 * O header pelo qual a equipe da plataforma diz em que estabelecimento está agindo
 * (MOD-ADMIN-02).
 *
 * Mesmo mecanismo do Portal, e pela mesma razão: quem chega não tem Organization no token,
 * então o tenant não sai dele. **Forjá-lo não leva a lugar nenhum** — o contexto resultante
 * só existe se houver `support_access_grant` vivo daquele suporte naquele tenant, e o grant
 * é o estabelecimento que o cria.
 *
 * Não confundir com `x-petshop-tenant-id`, que o `proxy.ts` descartava e que o
 * `auditForgedTenantHeader` ainda vigia: aquele era um contexto forjado; este é um pedido
 * de contexto, que a autorização do tenant concede ou não.
 */
const PLATFORM_TENANT_HEADER = 'x-petshop-acting-tenant'

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
    allowList: (request: FastifyRequest) => {
      const path = request.url.split('?')[0] ?? ''
      return path.startsWith(PUBLIC_PREFIX)
    },
    /**
     * MOD-SEC-09 — o webhook tem teto próprio, e mais folgado.
     *
     * Ele estava inteiramente **fora** do balde até a Fase 7, e a assinatura era a
     * defesa inteira: nada limitava quantas assinaturas inválidas alguém podia tentar
     * por segundo. O teto é maior que o do Admin porque provedor legítimo entrega em
     * rajada — a Evolution empurra um QR novo a cada ~45s durante o pareamento, e o
     * Resend agrupa retornos de entrega. Estreitá-lo até o teto do Admin transformaria
     * um pareamento normal em 429.
     */
    max: (_request: FastifyRequest, key: string) =>
      key.startsWith('webhook:') ? env.WEBHOOK_RATE_LIMIT_MAX : env.RATE_LIMIT_MAX,
    keyGenerator: (request: FastifyRequest) => {
      const path = request.url.split('?')[0] ?? ''
      // Prefixo no lugar de uma configuração separada: o `@fastify/rate-limit` é um
      // registro só, e o que separa os baldes é a chave.
      if (path.startsWith(WEBHOOK_PREFIX)) return `webhook:${request.ip}`

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
    if (path.startsWith(WEBHOOK_PREFIX)) return
    if (request.method === 'OPTIONS') return

    const context = isPlatformPath(path)
      ? await resolvePlatformRequest(request, path)
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

  return app
}

/**
 * A sessão da **equipe da plataforma** (MOD-ADMIN-01).
 *
 * É o terceiro caminho de resolução do processo, e a diferença dos outros dois não é de
 * implementação, é de modelo: a sessão da equipe do petshop sai da Organization do Clerk e
 * de `memberships`; a do tutor sai do host e de `tutors.portal_user_id`; esta sai de
 * `platform_admins`, uma tabela **sem `tenant_id`**.
 *
 * **Token com Organization nunca resolve aqui** (AC-03). Quem é da plataforma e também tem
 * ficha de administrador num petshop precisa trocar de contexto no Clerk para entrar; o
 * crachá de plataforma não se soma ao papel de tenant, e nenhum dos dois amplia o outro.
 * É a mesma fronteira que o Portal desenha com o header de host, e pela mesma razão.
 *
 * **A recusa é 404, e não 403** (RN-01). Um 403 confirmaria a quem está varrendo que a
 * superfície da plataforma existe; quem não é da equipe não recebe a informação de que há
 * uma equipe. É a mesma escolha que o MOD-PORTAL faz para recurso de outro tutor.
 */
async function resolvePlatformRequest(
  request: FastifyRequest,
  path: string,
): Promise<ServiceAuthContext> {
  const claims = await verifyBearer(request, path)
  if (claims.clerkOrgId) throw platformNotFound()

  const admin = await resolvePlatformAdmin(claims.clerkUserId)
  if (!admin) {
    request.log.warn({ path, clerkUserId: claims.clerkUserId }, 'acesso à plataforma recusado')
    throw platformNotFound()
  }

  /**
   * Sem `tenantId`, e é o que separa esta sessão de todas as outras: ela não pertence a
   * estabelecimento nenhum. As rotas de `/platform/v1` não tocam tabela com RLS — as que
   * tocarem, no MOD-ADMIN-02, o farão sob o grant e com o tenant resolvido ali.
   */
  return {
    clerkUserId: admin.clerkUserId,
    userId: admin.userId,
    role: 'SUPER_ADMIN',
    permissions: [...ROLE_PERMISSIONS.SUPER_ADMIN],
  }
}

/**
 * AC-01 de MOD-SEC-07 — o cliente que se declara de outro estabelecimento.
 *
 * O `proxy.ts` **descarta** os headers `x-petshop-*` que chegam de fora antes de
 * encaminhar, e é isso que torna a tentativa inofensiva. Só que descartar em silêncio
 * também a torna invisível: alguém pode varrer a instalação a semana inteira mandando
 * `x-petshop-tenant-id` de terceiros e não deixar rastro nenhum.
 *
 * Uma requisição legítima **nunca** carrega esse header pela porta de fora — quem o
 * envia com assinatura válida entra por `resolveInternalRequest`, que retorna antes
 * daqui. Então a presença dele já é a anomalia; o `!==` só separa o engano de
 * configuração da tentativa de alcançar outro tenant.
 */
async function auditForgedTenantHeader(
  request: FastifyRequest,
  context: ServiceAuthContext,
): Promise<void> {
  const raw = request.headers[SERVICE_HEADERS.tenantId]
  const claimed = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!claimed || claimed === context.tenantId) return

  await recordSecurityEvent({
    tenantId: context.tenantId ?? null,
    type: 'CROSS_TENANT_ATTEMPT',
    actorUserId: context.userId ?? null,
    targetEntity: 'tenant',
    targetId: claimed,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    metadata: { path: request.url.split('?')[0], method: request.method },
  })
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

  /**
   * O suporte da plataforma agindo dentro de um estabelecimento (MOD-ADMIN-02).
   *
   * Vem **antes** de `resolveSession` porque não há sessão de tenant a resolver: o token
   * não tem Organization, e `resolveSession` devolveria um contexto sem `tenantId` que
   * toda rota recusaria. O caminho é outro, e curto — grant vivo, leitura só, e uma linha
   * na trilha do estabelecimento.
   */
  if (!claims.clerkOrgId && request.headers[PLATFORM_TENANT_HEADER]) {
    return resolveSupportRequest(request, claims, path)
  }

  const { context, mfa } = await resolveSession(claims, {
    method: request.method,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  })
  request.mfa = mfa

  await auditForgedTenantHeader(request, context)

  if (context.tutorId) {
    request.log.warn({ path, tutorId: context.tutorId }, 'sessão de tutor barrada fora do Portal')
    throw new AppError('ERR_PORTAL_008', 'Esta área é da equipe do estabelecimento')
  }

  return context
}

/**
 * A sessão de **suporte dentro de um estabelecimento** (MOD-ADMIN-02).
 *
 * É a única forma de alguém de fora do petshop alcançar o dado dele, e o que a torna
 * defensável são três coisas conferidas aqui, nesta ordem:
 *
 * 1. **quem** — linha viva em `platform_admins`, ou 404 como em toda a superfície da
 *    plataforma: quem não é da equipe não descobre que a equipe existe;
 * 2. **autorização** — `support_access_grant` `ACTIVE` e no prazo, lido do banco **a cada
 *    requisição**, sem cache. É o que faz a revogação valer no clique seguinte (RN-03);
 * 3. **o quê** — só `GET`. O grant é de leitura, e a recusa de escrita é aqui, na porta,
 *    não espalhada por noventa handlers (AC-07).
 *
 * O contexto que sai daqui é o do **tenant**, com as permissões do `SUPER_ADMIN`: daí para
 * a frente a requisição é indistinguível de uma da equipe do petshop, e o RLS a limita ao
 * estabelecimento como limita qualquer outra. É o que faz o Admin inteiro funcionar para o
 * suporte sem uma tela nova.
 */
async function resolveSupportRequest(
  request: FastifyRequest,
  claims: SessionClaims,
  path: string,
): Promise<ServiceAuthContext> {
  const raw = request.headers[PLATFORM_TENANT_HEADER]
  const tenantId = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''

  const admin = await resolvePlatformAdmin(claims.clerkUserId)
  if (!admin) {
    request.log.warn({ path, clerkUserId: claims.clerkUserId }, 'acesso de suporte recusado')
    throw platformNotFound()
  }

  const grant = await findActiveGrant(admin.userId, tenantId)
  if (!grant) {
    throw needsGrant(undefined, { tenantId, grantPath: '/platform/v1/tenants/' + tenantId + '/support-access' })
  }

  /**
   * A recusa de escrita, e ela é total.
   *
   * `HEAD` e `OPTIONS` passam junto com `GET` porque não mudam nada; qualquer outro método
   * é recusado sem chegar ao roteador. Suporte que precisa corrigir dado pede ao
   * estabelecimento que corrija — um terceiro escrevendo na ficha do cliente é
   * indefensável na primeira reclamação.
   */
  if (!SUPPORT_READ_METHODS.has(request.method)) {
    throw readOnly()
  }

  /**
   * A prova, e ela é gravada **sem `await`** de propósito.
   *
   * A linha vai para a trilha do estabelecimento numa transação própria; esperá-la somaria
   * uma ida ao banco ao caminho de toda leitura do suporte. O helper engole a própria
   * falha e a registra em log, então nada aqui depende do resultado — e uma leitura que
   * não pôde ser registrada é um problema de observabilidade, não de autorização.
   */
  void recordSupportRead({
    tenantId,
    grantId: grant.id,
    adminUserId: admin.userId,
    method: request.method,
    path,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  })

  return {
    clerkUserId: admin.clerkUserId,
    userId: admin.userId,
    tenantId,
    role: 'SUPER_ADMIN',
    permissions: [...ROLE_PERMISSIONS.SUPER_ADMIN],
  }
}

/** Os métodos que o grant libera: os que não mudam nada. */
const SUPPORT_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

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
