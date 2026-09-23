import { loadEnv } from '../../../config/env.js'
import { logger } from '../../../shared/logger.js'

/**
 * O provedor de WhatsApp, atrás de porta injetável (MOD-CRM-01).
 *
 * Mesmo desenho de `modules/identity/clerk.ts` e pela mesma razão: a suíte
 * inteira roda sem um container de WhatsApp no ar, e o teste do pareamento exercita o
 * **nosso** código — a máquina de estados, o token do webhook, a cifra da chave — em
 * vez de exercitar a Evolution.
 *
 * A escolha do provedor está no §1 do PRD e custa caro assumir: é camada não-oficial
 * sobre o WhatsApp Web, o número pode ser banido, e é esse risco que justifica a
 * janela de silêncio, o teto diário, o aquecimento e o jitter. Tudo o que este arquivo
 * faz de próprio é traduzir HTTP; toda a política vive do lado de cá.
 */

/** Como a Evolution nomeia o estado da sessão. */
export type EvolutionState = 'open' | 'close' | 'connecting'

export interface EvolutionCreated {
  /** A chave **daquela instância**, diferente da chave global do servidor. */
  apiKey: string
  /** `data:image/png;base64,…`, quando o provedor já devolveu o QR na criação. */
  qrCode: string | null
}

export interface EvolutionSession {
  state: EvolutionState
  /** Número pareado, em E.164 quando o provedor o informa. */
  phone: string | null
}

export interface EvolutionSendResult {
  ok: boolean
  providerMessageId: string | null
  /** Não adianta repetir: número sem WhatsApp, instância morta, conta bloqueada. */
  permanent: boolean
  /** `BANNED` é o único que troca o estado da instância — ver `whatsapp.ts`. */
  errorCode: string | null
  errorDetail: string | null
}

/**
 * O que a Evolution manda de volta.
 *
 * Os dois primeiros são o pareamento, e foram os únicos até o MOD-AI. `MESSAGES_UPSERT`
 * é a mensagem que o cliente escreveu — **sem ele o produto continua surdo**, e o
 * sintoma é o pior tipo: nada falha, nada aparece no log, a fila de atendimento fica
 * vazia para sempre e parece que ninguém escreveu.
 *
 * A lista é gravada do lado do provedor, uma vez, quando a instância nasce. Instância
 * pareada antes desta linha existir continua com a lista antiga até alguém reafirmar o
 * endereço de retorno — é o que o job `messaging.reaffirm-webhook` faz todo dia.
 */
const WEBHOOK_EVENTS = ['CONNECTION_UPDATE', 'QRCODE_UPDATED', 'MESSAGES_UPSERT']

export interface EvolutionPort {
  /** `false` quando falta `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` no ambiente. */
  readonly configured: boolean
  createInstance(input: {
    instanceName: string
    webhookUrl: string
    webhookToken: string
  }): Promise<EvolutionCreated>
  /**
   * Reafirma o endereço de retorno de uma instância que já existe.
   *
   * A Evolution guarda o webhook **dela**, gravado uma vez na criação, e nada no
   * sistema voltava a escrevê-lo. Bastou o backend mudar de porta na consolidação
   * para todas as instâncias do parque ficarem apontando para um endereço morto: o
   * pareamento nunca mais chegava ao fim, o estado no banco congelava no último que
   * o webhook contou, e não havia erro em lugar nenhum — só um QR que gira e uma
   * conexão que o painel jura estar de pé.
   */
  setWebhook(input: {
    instanceName: string
    apiKey: string
    webhookUrl: string
    webhookToken: string
  }): Promise<void>
  /** QR novo **sem** recriar a instância (AC-03) — recriar perderia o histórico. */
  requestQrCode(instanceName: string, apiKey: string): Promise<string | null>
  fetchSession(instanceName: string, apiKey: string): Promise<EvolutionSession>
  sendText(input: {
    instanceName: string
    apiKey: string
    to: string
    text: string
  }): Promise<EvolutionSendResult>
  logout(instanceName: string, apiKey: string): Promise<void>
  /**
   * Apaga a instância no provedor — **a identidade junto**.
   *
   * `logout` encerra a sessão e preserva as chaves de identidade; esta apaga tudo. A
   * distinção é o que separa "reconectar" de "recomeçar": uma identidade que o
   * WhatsApp passou a recusar não volta a ser aceita por QR nenhum, porque o código
   * muda e ela não. Sem isto não há como sair desse estado.
   */
  deleteInstance(instanceName: string, apiKey: string): Promise<void>
}

const REQUEST_TIMEOUT_MS = 12_000

/**
 * O que a falha de um envio diz — **sobre quem**.
 *
 * O despacho suprime o endereço de toda falha permanente que não seja
 * `CHANNEL_UNAVAILABLE`, e isso só é certo quando o defeito é do **destinatário**. Até
 * 2026-09-23 esta função não separava as duas coisas: um 401 da Evolution — a chave
 * errada na VPS nova, antes de o WhatsApp ser pareado — voltava como falha permanente, e
 * o número do **cliente** entrava na lista de supressão como "devolução definitiva". A
 * partir daí nenhuma mensagem saía para ele, nem o push que vai junto, e nada no painel
 * apontava para a Evolution.
 *
 * Três casos, portanto:
 *
 * - **401, 403, 404** são do canal do petshop — chave recusada, instância sem permissão,
 *   instância apagada. Viram `CHANNEL_UNAVAILABLE`: a mensagem volta à fila sem contar
 *   tentativa e sai sozinha quando a Evolution for consertada.
 * - **O número sem WhatsApp** é o único defeito do destinatário que a Evolution relata:
 *   400 com `exists: false` na resposta. Vira `NOT_ON_WHATSAPP`, permanente, e esse sim
 *   suprime.
 * - **Qualquer outro 400/422** é o corpo que **nós** mandamos. Falha, mas não é
 *   permanente: retenta e morre pelo backoff, sem suprimir ninguém. Suprimir por ele
 *   envenenaria a base inteira no dia de um defeito no payload.
 */
export function classifySendFailure(
  status: number,
  body: unknown,
  detail: string,
): EvolutionSendResult {
  const base = { ok: false as const, providerMessageId: null, errorDetail: detail }

  if (isBan(detail)) {
    // `WHATSAPP_BANNED` é lido por `whatsapp.ts`, que derruba a instância e faz as
    // pendentes caírem para o e-mail (AC-05). Nenhum outro código faz isso.
    return { ...base, permanent: true, errorCode: 'WHATSAPP_BANNED' }
  }

  if (status === 401 || status === 403 || status === 404) {
    return {
      ...base,
      permanent: true,
      errorCode: 'CHANNEL_UNAVAILABLE',
      errorDetail: `A Evolution recusou o envio (HTTP ${status}): ${detail}`.slice(0, 480),
    }
  }

  if ((status === 400 || status === 422) && numberDoesNotExist(body)) {
    return { ...base, permanent: true, errorCode: 'NOT_ON_WHATSAPP' }
  }

  return { ...base, permanent: false, errorCode: `EVOLUTION_${status}` }
}

/** `{"response":{"message":[{"exists":false,"number":"5511…"}]}}`, em qualquer profundidade. */
function numberDoesNotExist(body: unknown): boolean {
  return /"exists"\s*:\s*false/.test(typeof body === 'string' ? body : JSON.stringify(body ?? ''))
}

/** O que o provedor diz quando a conta foi bloqueada pela Meta (AC-05). */
const BAN_MARKERS = ['banned', 'blocked', 'forbidden device', 'account is disabled']

function isBan(detail: string): boolean {
  const lower = detail.toLowerCase()
  return BAN_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * `apenas dígitos` — a Evolution recusa o `+` e a formatação brasileira.
 *
 * Vem daqui e não do cadastro porque o telefone do tutor é digitado por gente: chega
 * como `(11) 98888-7777`, e é o mesmo valor que o e-mail nunca precisa tocar.
 */
function toWhatsappNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  // Número brasileiro sem código do país: a Evolution o entregaria a um desconhecido
  // noutro país em vez de recusar, então o 55 entra aqui.
  if (digits.length === 10 || digits.length === 11) return `55${digits}`
  return digits
}

/** A Evolution devolve o QR como base64 cru ou já como data URI, conforme a rota. */
function toDataUri(base64: string | null | undefined): string | null {
  if (!base64) return null
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  apiKey: string
  body?: unknown
}

function createHttpPort(baseUrl: string, globalApiKey: string): EvolutionPort {
  async function request(options: RequestOptions): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${baseUrl}${options.path}`, {
        method: options.method,
        headers: {
          'content-type': 'application/json',
          apikey: options.apiKey,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const text = await response.text()
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        // A Evolution responde HTML em alguns erros de proxy. O texto cru serve de
        // detalhe; o que importa é o status.
        parsed = { message: text.slice(0, 200) }
      }
      return { status: response.status, body: parsed }
    } finally {
      clearTimeout(timeout)
    }
  }

  function detailOf(body: unknown): string {
    if (typeof body === 'string') return body.slice(0, 280)
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      const raw = record.message ?? record.error ?? record.response
      if (typeof raw === 'string') return raw.slice(0, 280)
      if (raw) return JSON.stringify(raw).slice(0, 280)
    }
    return ''
  }

  async function requireOk(options: RequestOptions): Promise<unknown> {
    const { status, body } = await request(options)
    if (status >= 400) {
      throw new EvolutionRequestError(status, detailOf(body) || `HTTP ${status}`)
    }
    return body
  }

  return {
    configured: true,

    async createInstance({ instanceName, webhookUrl, webhookToken }) {
      const body = await requireOk({
        method: 'POST',
        path: '/instance/create',
        apiKey: globalApiKey,
        body: {
          instanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
          webhook: {
            // O token vai **duas vezes**: no cabeçalho e na query. Versões da Evolution
            // divergem em quais cabeçalhos personalizados repassam, e um webhook que
            // chega sem se identificar é um webhook recusado — o petshop ficaria
            // preso em "Aguardando leitura do QR" para sempre, sem erro em lugar nenhum.
            url: `${webhookUrl}?token=${encodeURIComponent(webhookToken)}`,
            headers: { 'x-webhook-token': webhookToken },
            byEvents: false,
            base64: true,
            events: WEBHOOK_EVENTS,
          },
        },
      })

      const record = (body ?? {}) as Record<string, unknown>
      // v1 devolvia `hash: { apikey }`; v2 devolve `hash` como string.
      const hash = record.hash
      const apiKey =
        typeof hash === 'string'
          ? hash
          : ((hash as Record<string, unknown> | undefined)?.apikey as string | undefined)

      const qr = record.qrcode as Record<string, unknown> | undefined

      return {
        // Sem `hash` a instância existe mas não temos como falar com ela; a chave
        // global funciona para tudo, e é a queda que evita uma instância órfã.
        apiKey: apiKey ?? globalApiKey,
        qrCode: toDataUri(qr?.base64 as string | undefined),
      }
    },

    async setWebhook({ instanceName, apiKey, webhookUrl, webhookToken }) {
      await requireOk({
        method: 'POST',
        path: `/webhook/set/${encodeURIComponent(instanceName)}`,
        apiKey,
        body: {
          webhook: {
            enabled: true,
            // O token duas vezes, pela mesma razão da criação: versões divergem em
            // quais cabeçalhos personalizados repassam.
            url: `${webhookUrl}?token=${encodeURIComponent(webhookToken)}`,
            headers: { 'x-webhook-token': webhookToken },
            byEvents: false,
            base64: true,
            events: WEBHOOK_EVENTS,
          },
        },
      })
    },

    async requestQrCode(instanceName, apiKey) {
      const body = await requireOk({
        method: 'GET',
        path: `/instance/connect/${encodeURIComponent(instanceName)}`,
        apiKey,
      })
      const record = (body ?? {}) as Record<string, unknown>
      return toDataUri(
        (record.base64 as string | undefined) ??
          ((record.qrcode as Record<string, unknown> | undefined)?.base64 as string | undefined),
      )
    },

    async fetchSession(instanceName, apiKey) {
      const body = await requireOk({
        method: 'GET',
        path: `/instance/connectionState/${encodeURIComponent(instanceName)}`,
        apiKey,
      })
      const instance = ((body ?? {}) as Record<string, unknown>).instance as
        | Record<string, unknown>
        | undefined

      const state = (instance?.state as EvolutionState | undefined) ?? 'close'
      // `ownerJid` chega como `5511988887777@s.whatsapp.net`.
      const jid = (instance?.ownerJid ?? instance?.owner) as string | undefined
      const phone = jid ? `+${jid.split('@')[0]}` : null

      return { state, phone }
    },

    async sendText({ instanceName, apiKey, to, text }) {
      const { status, body } = await request({
        method: 'POST',
        path: `/message/sendText/${encodeURIComponent(instanceName)}`,
        apiKey,
        body: { number: toWhatsappNumber(to), text },
      })

      if (status < 400) {
        const key = ((body ?? {}) as Record<string, unknown>).key as
          | Record<string, unknown>
          | undefined
        return {
          ok: true,
          providerMessageId: (key?.id as string | undefined) ?? null,
          permanent: false,
          errorCode: null,
          errorDetail: null,
        }
      }

      return classifySendFailure(status, body, detailOf(body) || `HTTP ${status}`)
    },

    async logout(instanceName, apiKey) {
      const { status, body } = await request({
        method: 'DELETE',
        path: `/instance/logout/${encodeURIComponent(instanceName)}`,
        apiKey,
      })
      // 404 é sucesso aqui: desconectar o que já não existe deixa o mundo no estado
      // pedido. Só o resto vira erro.
      if (status >= 400 && status !== 404) {
        throw new EvolutionRequestError(status, detailOf(body) || `HTTP ${status}`)
      }
    },

    async deleteInstance(instanceName, apiKey) {
      const { status, body } = await request({
        method: 'DELETE',
        path: `/instance/delete/${encodeURIComponent(instanceName)}`,
        apiKey,
      })
      // Mesmo raciocínio do `logout`: apagar o que já não existe é o estado pedido.
      if (status >= 400 && status !== 404) {
        throw new EvolutionRequestError(status, detailOf(body) || `HTTP ${status}`)
      }
    },
  }
}

/** Erro de transporte/protocolo com a Evolution. O chamador decide se vira 502 ou log. */
export class EvolutionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'EvolutionRequestError'
  }
}

/**
 * A porta de quem não configurou a Evolution.
 *
 * Não lança na construção nem na subida: o serviço precisa continuar entregando e-mail
 * sem nenhuma variável de WhatsApp definida. Quem chama uma rota de conexão sem
 * provedor recebe um 422 com texto de gente, vindo de `whatsapp.ts`.
 */
function createUnconfiguredPort(): EvolutionPort {
  const fail = (): never => {
    throw new EvolutionRequestError(503, 'A Evolution API não está configurada')
  }
  return {
    configured: false,
    createInstance: fail,
    setWebhook: fail,
    requestQrCode: fail,
    fetchSession: fail,
    logout: fail,
    deleteInstance: fail,
    async sendText() {
      return {
        ok: false,
        providerMessageId: null,
        permanent: true,
        errorCode: 'CHANNEL_UNAVAILABLE',
        errorDetail: 'O canal WhatsApp não está configurado nesta instalação',
      }
    },
  }
}

let port: EvolutionPort | null = null

export function getEvolutionPort(): EvolutionPort {
  if (port) return port

  const env = loadEnv()
  if (!env.EVOLUTION_API_URL || !env.EVOLUTION_API_KEY) {
    logger.info('Evolution API não configurada — o canal WhatsApp fica indisponível')
    port = createUnconfiguredPort()
    return port
  }

  port = createHttpPort(env.EVOLUTION_API_URL.replace(/\/+$/, ''), env.EVOLUTION_API_KEY)
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setEvolutionPort(next: EvolutionPort | null): void {
  port = next
}
