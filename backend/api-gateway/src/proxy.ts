import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { loadEnv } from './env.js'
import { logger } from './lib/logger.js'

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
  'x-petshop-permissions',
  'x-petshop-perm-version',
  'x-petshop-timestamp',
  'x-petshop-signature',
])

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'connection',
  'transfer-encoding',
])

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
      ...(hasBody && request.body !== undefined
        ? { body: JSON.stringify(request.body), duplex: 'half' }
        : {}),
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

const TUTOR_PREFIXES = ['/v1/tutors']

function matches(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export function resolveTarget(path: string): string | null {
  const env = loadEnv()
  if (matches(path, IDENTITY_PREFIXES)) return env.IDENTITY_SERVICE_URL
  if (matches(path, TUTOR_PREFIXES)) return env.TUTOR_SERVICE_URL
  return null
}
