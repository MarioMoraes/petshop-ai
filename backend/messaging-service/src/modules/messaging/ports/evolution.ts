import { loadEnv } from '../../../env.js'
import { logger } from '../../../lib/logger.js'

/**
 * O provedor de WhatsApp, atrás de porta injetável (MOD-CRM-01).
 *
 * Mesmo desenho de `identity-service/src/lib/clerk.ts` e pela mesma razão: a suíte
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

export interface EvolutionPort {
  /** `false` quando falta `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` no ambiente. */
  readonly configured: boolean
  createInstance(input: {
    instanceName: string
    webhookUrl: string
    webhookToken: string
  }): Promise<EvolutionCreated>
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
 * Erros da Evolution que não adianta repetir.
 *
 * `404` merece nota: significa que a instância sumiu do lado do provedor (alguém a
 * apagou, ou o volume foi perdido). Insistir não a traz de volta — o petshop precisa
 * parear de novo, e quem diz isso é a faixa da tela.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422])

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
            events: ['CONNECTION_UPDATE', 'QRCODE_UPDATED'],
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

      const detail = detailOf(body) || `HTTP ${status}`
      const banned = isBan(detail)
      return {
        ok: false,
        providerMessageId: null,
        permanent: banned || PERMANENT_STATUSES.has(status),
        // `WHATSAPP_BANNED` é lido por `whatsapp.ts`, que derruba a instância e faz as
        // pendentes caírem para o e-mail (AC-05). Nenhum outro código faz isso.
        errorCode: banned ? 'WHATSAPP_BANNED' : `EVOLUTION_${status}`,
        errorDetail: detail,
      }
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
