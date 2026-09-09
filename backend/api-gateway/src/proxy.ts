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
 * Roteamento por prefixo — **e não sobrou mais nenhum de `/v1`**.
 *
 * A tabela encolheu a cada fatia da consolidação e, depois da 10, o único destino é o
 * Portal. O que ficou abaixo é o registro das três formas que ela tinha, porque cada uma
 * documenta uma armadilha que o roteador do Fastify passou a cobrir sozinho.
 */

/**
 * **A tabela do MOD-AGENDA saiu na fatia 9.** Eram sete prefixos — `/v1/services`,
 * `/v1/professionals`, `/v1/calendar-blocks`, `/v1/availability`, `/v1/agenda`,
 * `/v1/appointments` e `/v1/recurrences` —, todos distintos e nenhum precisando de
 * sufixo para desempatar. A distinção que eles guardavam era contra `/v1/sizes`, do
 * catálogo de domínio do MOD-PET, e ela sobrevive na árvore de rotas: são prefixos
 * diferentes, e um conflito real apareceria no boot.
 */

/**
 * **A exceção por sufixo do prontuário saiu na fatia 8, e vale registrar por quê.**
 *
 * Enquanto o MOD-PRONT era serviço, as rotas dele penduravam-se sob `/v1/pets/:petId/…`
 * e o roteamento era por **sufixo** — `/safety-record`, `/alerts`, `/timeline` e mais
 * seis —, conferido antes do prefixo do pet. Aquilo funcionava por coincidência: nenhuma
 * rota do módulo de pets casava com esses sufixos, e no dia em que alguém registrasse
 * uma que casasse, o Fastify preferiria a do módulo e a rota do prontuário sumiria sem
 * erro nenhum, em produção.
 *
 * Com os dois módulos na mesma árvore de rotas, o desempate deixou de ser uma lista aqui
 * e passou a ser o roteador — que reclama no boot em vez de escolher em silêncio.
 */

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

/**
 * **A última exceção de prefixo saiu na fatia 10, e com ela a última tabela.**
 *
 * O MOD-LEDGER tinha quatro prefixos — `/v1/ledger`, `/v1/payments`, `/v1/packages` e
 * `/v1/billing-settings` — e uma exceção por sufixo: `/v1/tutors/:tutorId/packages`, que
 * mora debaixo do espaço do MOD-TUTOR porque é da conta do tutor que se fala. Aquela
 * checagem precisava vir **antes** do prefixo dos tutores, e era o mesmo desenho frágil
 * que o prontuário tinha: funcionava porque nenhuma rota do MOD-TUTOR casava com ela.
 *
 * Com os dois módulos na mesma árvore, quem desempata é o roteador — e `:tutorId` aqui
 * convive com `:id` lá, como o `find-my-way` já provava com o `:petId` do prontuário.
 *
 * **Sobrou um destino só: o `portal-bff`.** Quando ele migrar, este arquivo sai inteiro,
 * junto com o `resolveInternalRequest` do `app.ts`.
 */

function matches(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export function resolveTarget(path: string): string | null {
  const env = loadEnv()
  if (isPortalPath(path)) return env.PORTAL_BFF_URL
  return null
}
