import { createSign } from 'node:crypto'
import { loadEnv } from '../../../config/env.js'
import { logger } from '../../../shared/logger.js'

/**
 * Push para o app do tutor, via Firebase Cloud Messaging (etapa 9 do app).
 *
 * A API HTTP v1 com `fetch`, e não o `firebase-admin`: são um POST de token OAuth e um
 * POST de mensagem, e o SDK traria dezenas de dependências para a imagem de backend —
 * que é uma só. Mesma escolha do Resend em `email.ts`.
 *
 * **Não é um `ChannelPort`.** O push não é um canal do motor: ele vai junto com a
 * mensagem de WhatsApp ou e-mail, depois de ela passar por consentimento, janela e
 * supressão. Quem o chama é `push.ts`, do despacho, e a interface aqui é do tamanho do
 * que ele pede.
 */

export interface PushRequest {
  token: string
  title: string
  body: string
  /** O que o app lê para saber para onde abrir. Só strings: é o que o FCM aceita. */
  data: Record<string, string>
}

export interface PushResult {
  ok: boolean
  providerMessageId: string | null
  /** O token não vale mais (app desinstalado, dados apagados): o aparelho sai da lista. */
  invalidToken?: boolean
  errorCode?: string
}

export interface PushPort {
  /** Sem credencial, o push não existe — e o despacho nem lê os aparelhos. */
  isAvailable(): boolean
  send(request: PushRequest): Promise<PushResult>
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const SEND_TIMEOUT_MS = 8_000

interface ServiceAccount {
  client_email: string
  private_key: string
}

/**
 * O token de acesso do Google vale uma hora. Ele é pedido de novo com cinco minutos de
 * folga, para que nenhum envio saia com um token que expira no caminho.
 */
const TOKEN_MARGIN_MS = 5 * 60_000

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function createFcmPort(projectId: string, account: ServiceAccount): PushPort {
  let cached: { token: string; expiresAt: number } | null = null

  /**
   * A troca do JWT da conta de serviço por um token de acesso (OAuth 2.0, RFC 7523).
   *
   * Assinado aqui, com `node:crypto`: o JWT é um cabeçalho, um corpo e uma assinatura
   * RS256 — três linhas, e não uma biblioteca.
   */
  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.token

    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64url(
      JSON.stringify({
        iss: account.client_email,
        scope: SCOPE,
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 3600,
      }),
    )
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    const assertion = `${header}.${claims}.${base64url(signer.sign(account.private_key))}`

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`token do Google recusado: ${response.status}`)
    }
    const json = (await response.json()) as { access_token: string; expires_in: number }
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 }
    return json.access_token
  }

  return {
    isAvailable: () => true,

    async send(request: PushRequest): Promise<PushResult> {
      try {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${await accessToken()}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: request.token,
                notification: { title: request.title, body: request.body },
                data: request.data,
                android: {
                  // `high` porque o aviso da van e o "está pronto" perdem o sentido se
                  // chegarem quando o Android achar conveniente acordar o rádio.
                  priority: 'high',
                  notification: { channel_id: 'avisos' },
                },
              },
            }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          },
        )

        if (response.ok) {
          const json = (await response.json()) as { name?: string }
          return { ok: true, providerMessageId: json.name ?? null }
        }

        const erro = (await response.json().catch(() => null)) as {
          error?: { status?: string; details?: { errorCode?: string }[] }
        } | null
        const codigo =
          erro?.error?.details?.find((d) => d.errorCode)?.errorCode ??
          erro?.error?.status ??
          `HTTP_${response.status}`

        // Só `UNREGISTERED` (404) revoga o aparelho: é o app desinstalado. O
        // `INVALID_ARGUMENT` fica de fora de propósito — ele também é a resposta a um
        // corpo malformado **nosso**, e revogar por ele apagaria todos os aparelhos da
        // base no dia de um defeito no payload.
        const invalido = response.status === 404 || codigo === 'UNREGISTERED'
        return { ok: false, providerMessageId: null, invalidToken: invalido, errorCode: codigo }
      } catch (error) {
        logger.warn({ err: error }, 'push: falha ao falar com o FCM')
        return { ok: false, providerMessageId: null, errorCode: 'NETWORK' }
      }
    },
  }
}

const unavailablePort: PushPort = {
  isAvailable: () => false,
  async send() {
    return { ok: false, providerMessageId: null, errorCode: 'NOT_CONFIGURED' }
  },
}

let port: PushPort | null = null

export function getPushPort(): PushPort {
  if (port) return port
  const env = loadEnv()
  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_JSON_B64) {
    port = unavailablePort
    return port
  }
  try {
    const account = JSON.parse(
      Buffer.from(env.FCM_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'),
    ) as ServiceAccount
    if (!account.client_email || !account.private_key) throw new Error('campos ausentes')
    port = createFcmPort(env.FCM_PROJECT_ID, account)
  } catch (error) {
    // Credencial mal colada não derruba o processo: o push fica desligado e o resto do
    // produto segue. O log diz o que houve, uma vez.
    logger.error({ err: error }, 'push: FCM_SERVICE_ACCOUNT_JSON_B64 ilegível — push desligado')
    port = unavailablePort
  }
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setPushPort(next: PushPort | null): void {
  port = next
}
