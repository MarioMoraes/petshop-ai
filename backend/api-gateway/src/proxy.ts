import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { loadEnv } from './config/env.js'
import { logger } from './shared/logger.js'

/**
 * Encaminhamento para os microserviços.
 *
 * O gateway reescreve os headers de autenticação: descarta o `Authorization` do
 * cliente e assina o contexto já resolvido. O serviço de destino nunca vê o token do
 * usuário — só o resultado, com a assinatura que prova que veio daqui.
 */

/** Headers que nunca são repassados adiante. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  // Impede que um cliente forje o contexto imitando os headers internos.
  'x-petshop-clerk-user-id',
  'x-petshop-user-id',
  'x-petshop-tenant-id',
  'x-petshop-role',
  'x-petshop-tutor-id',
  'x-petshop-permissions',
  'x-petshop-perm-version',
  'x-petshop-timestamp',
  'x-petshop-signature',
  // O slug do Portal é insumo do gateway, não do serviço: o que segue adiante é o
  // `tenantId` já resolvido, dentro da assinatura. Repassar o slug daria ao serviço uma
  // segunda fonte de verdade sobre de que petshop se fala, e as duas divergiriam um dia.
  'x-petshop-tenant-slug',
])

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'connection',
  'transfer-encoding',
])

/**
 * Corpo já parseado de volta para bytes.
 *
 * Upload de foto (MOD-PET-04) chega como `multipart/form-data` e é bufferizado pelo
 * parser bruto do `app.ts`. Ele precisa seguir **byte a byte**: o `boundary` que
 * delimita as partes está no `content-type`, e qualquer reserialização quebraria a
 * correspondência entre os dois. JSON continua indo como JSON.
 */
function encodeBody(body: unknown): Buffer | string {
  return Buffer.isBuffer(body) ? body : JSON.stringify(body)
}

export interface ProxyOptions {
  targetBaseUrl: string
  context: ServiceAuthContext
  timeoutMs?: number
}

export async function proxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProxyOptions,
): Promise<FastifyReply> {
  const env = loadEnv()
  const url = new URL(request.url, options.targetBaseUrl)

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (STRIPPED_REQUEST_HEADERS.has(name) || value === undefined) continue
    headers[name] = Array.isArray(value) ? value.join(',') : value
  }
  Object.assign(headers, signServiceHeaders(options.context, env.INTERNAL_SERVICE_SECRET))
  headers['x-request-id'] = String(request.id)
  headers['x-forwarded-for'] = request.ip

  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)

  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      ...(hasBody && request.body !== undefined ? { body: encodeBody(request.body), duplex: 'half' } : {}),
      signal: controller.signal,
    })

    for (const [name, value] of upstream.headers.entries()) {
      if (STRIPPED_RESPONSE_HEADERS.has(name)) continue
      void reply.header(name, value)
    }

    const payload = await upstream.arrayBuffer()
    return reply.status(upstream.status).send(Buffer.from(payload))
  } catch (error) {
    if (controller.signal.aborted) {
      logger.error({ url: url.toString() }, 'timeout ao chamar o serviço de destino')
      return reply.status(504).type('application/problem+json').send({
        type: 'https://docs.petshopai.com/errors/ERR_GATEWAY_TIMEOUT',
        title: 'Tempo esgotado',
        status: 504,
        code: 'ERR_GATEWAY_TIMEOUT',
        detail: 'O serviço demorou demais para responder. Tente novamente.',
        traceId: String(request.id),
      })
    }

    logger.error({ err: error, url: url.toString() }, 'falha ao chamar o serviço de destino')
    return reply.status(502).type('application/problem+json').send({
      type: 'https://docs.petshopai.com/errors/ERR_GATEWAY_UPSTREAM',
      title: 'Serviço indisponível',
      status: 502,
      code: 'ERR_GATEWAY_UPSTREAM',
      detail: 'Não foi possível concluir a operação. Tente novamente.',
      traceId: String(request.id),
    })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Roteamento por prefixo. A tabela cresce à medida que os serviços do SPEC §2 chegam.
 */
const IDENTITY_PREFIXES = [
  '/v1/tenants',
  '/v1/memberships',
  '/v1/invitations',
  '/v1/roles',
  '/v1/me',
  '/v1/sessions',
]

// O catálogo de domínio (MOD-PET-03) mora no pet-service: espécie, raça, porte e
// pelagem só existem para serem referenciados por um pet.
// MOD-AGENDA. Prefixos distintos, sem sufixo a desempatar: `/v1/services` não colide
// com `/v1/sizes` (pet-service) porque `matches` compara segmento inteiro.
const SCHEDULING_PREFIXES = [
  '/v1/services',
  '/v1/professionals',
  '/v1/calendar-blocks',
  '/v1/availability',
  '/v1/agenda',
  '/v1/appointments',
  '/v1/recurrences',
]

/**
 * O prontuário pendura suas rotas debaixo de `/v1/pets/:petId/…`, porque é do pet
 * que se fala. O roteamento é por **sufixo**, então precisa vir antes do prefixo de
 * pets — senão `/v1/pets/x/allergies` cairia no pet-service.
 */
const RECORD_SUFFIXES = [
  '/safety-record',
  '/alerts',
  '/allergies',
  '/allergy-check',
  '/temperament',
  '/medical-alerts',
  // MOD-PRONT-02 e 11.
  '/timeline',
  '/summary',
  // MOD-DOC-04: o receituário do pet.
  '/prescriptions',
]

/**
 * O atendimento (MOD-PRONT-01) tem prefixo próprio, e ele precisa ser avaliado
 * **antes** do da agenda: `/v1/attendances` não colide com `/v1/appointments`, mas a
 * proximidade dos dois é justamente o tipo de coisa que alguém "consolida" um dia.
 * O registro é do prontuário; o horário é da agenda.
 *
 * `/v1/prescriptions` entra junto (MOD-DOC-04): o receituário é documento, mas quem o
 * emite é quem sabe o que é uma prescrição — e isso é o prontuário. O
 * `document-service:3012` do SPEC não nasce.
 */
const ATTENDANCE_PREFIXES = ['/v1/attendances', '/v1/prescriptions']

function isRecordPath(path: string): boolean {
  if (!path.startsWith('/v1/pets/')) return false
  return RECORD_SUFFIXES.some(
    (suffix) => path.endsWith(suffix) || path.includes(`${suffix}/`),
  )
}

/**
 * MOD-SITE. Só a superfície **administrativa** passa por aqui: o `/public/v1/site` do
 * visitante anônimo não é roteado pelo gateway, e isso é decisão de segurança — o
 * gateway existe para validar sessão do Clerk, e abrir nele um ramo sem autenticação
 * seria publicar a API interna para o mundo. Quem chama a superfície pública é o Next,
 * pela rede interna, no SSR da página do tenant.
 */
/**
 * MOD-PORTAL. Prefixo próprio, e não um ramo de `/v1`, e isso é a decisão de segurança
 * do módulo (AC-04 de MOD-PORTAL-11): a superfície do cliente final tem allowlist de
 * rotas, rate limit e resolução de sessão separados, e **nenhum papel `TUTOR` alcança o
 * `/v1` administrativo**. Um dia em que as duas dividissem prefixo, uma rota nova do
 * Admin nasceria ao alcance de quem tem só `_own` sem que ninguém percebesse.
 */
const PORTAL_PREFIXES = ['/portal/v1']

export function isPortalPath(path: string): boolean {
  return matches(path, PORTAL_PREFIXES)
}

const LEDGER_PREFIXES = [
  '/v1/ledger',
  '/v1/payments',
  '/v1/packages',
  '/v1/billing-settings',
]

/**
 * Os pacotes de um tutor moram em `/v1/tutors/:tutorId/packages`, porque é da conta
 * dele que se fala. Mesmo problema do prontuário: o roteamento é por prefixo, então
 * esta checagem precisa vir **antes** de `TUTOR_PREFIXES` — senão a rota cairia no
 * tutor-service, que não conhece pacote nenhum.
 */
function isLedgerTutorPath(path: string): boolean {
  return path.startsWith('/v1/tutors/') && path.endsWith('/packages')
}

function matches(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export function resolveTarget(path: string): string | null {
  const env = loadEnv()
  if (isPortalPath(path)) return env.PORTAL_BFF_URL
  if (matches(path, IDENTITY_PREFIXES)) return env.IDENTITY_SERVICE_URL
  if (isLedgerTutorPath(path)) return env.BILLING_LEDGER_SERVICE_URL
  if (isRecordPath(path)) return env.MEDICAL_RECORD_SERVICE_URL
  if (matches(path, ATTENDANCE_PREFIXES)) return env.MEDICAL_RECORD_SERVICE_URL
  if (matches(path, SCHEDULING_PREFIXES)) return env.SCHEDULING_SERVICE_URL
  if (matches(path, LEDGER_PREFIXES)) return env.BILLING_LEDGER_SERVICE_URL
  return null
}
