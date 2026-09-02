import { loadEnv } from '../../../env.js'
import { logger } from '../../../lib/logger.js'
import type { ChannelPort, SendRequest, SendResult } from './registry.js'

/**
 * E-mail via Resend, chamado pela API HTTP com `fetch` — não pelo SDK.
 *
 * Mesma escolha do `mailer.ts` do identity-service, pela mesma razão: são dois campos
 * num POST, e um pacote a mais no `node_modules` (a imagem de backend é uma só) não se
 * paga por isso. **Quando o MOD-NOTIF for implementado, é o convite de equipe que
 * migra para cá**, não o contrário — este é o motor único de saída.
 *
 * Sem `RESEND_API_KEY` ou sem `MAIL_FROM`, o envio vira log e a mensagem é marcada
 * como enviada com `provider = 'log'`. É o estado de desenvolvimento e o do primeiro
 * deploy: travar a fila por falta de chave trocaria um problema de entrega por um de
 * fila cheia, e no dia da configuração o petshop dispararia semanas de lembrete de uma
 * vez.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 8_000

/**
 * Erros do Resend que não adianta repetir: endereço inválido, destinatário bloqueado,
 * remetente não verificado. Reenviar qualquer um deles quatro vezes só queima
 * reputação do domínio.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422])

function createResendPort(apiKey: string, from: string): ChannelPort {
  return {
    // O e-mail está de pé para todo tenant da instalação: sem `RESEND_API_KEY` ele
    // degrada para log, e nunca fica indisponível. É o contraste com o WhatsApp, que
    // depende de um pareamento por petshop.
    async isAvailable() {
      return true
    },
    async send(request: SendRequest): Promise<SendResult> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
      try {
        // `MAIL_FROM` pode vir só como endereço (`contato@dominio`) ou já com nome
        // (`PetShop AI <contato@dominio>`), que é o formato do `.env` deste projeto.
        // Prefixar o segundo caso produziria `Nome <PetShop AI <contato@…>>`, que o
        // Resend recusa — e a recusa só apareceria em produção, no primeiro envio.
        const sender =
          request.senderName && !from.includes('<') ? `${request.senderName} <${from}>` : from
        const response = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: sender,
            to: [request.to],
            subject: request.subject ?? '',
            text: request.body,
            html: renderHtml(request.body),
            ...(request.replyTo ? { reply_to: request.replyTo } : {}),
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          // O endereço do destinatário fica fora do log: é o dado pessoal que este
          // serviço justamente manipula.
          const detail = (await response.text().catch(() => '')).slice(0, 400)
          logger.error({ status: response.status, detail }, 'Resend recusou o envio')
          return {
            ok: false,
            providerMessageId: null,
            provider: 'resend',
            permanent: PERMANENT_STATUSES.has(response.status),
            errorCode: `HTTP_${response.status}`,
            errorDetail: detail,
          }
        }

        const body = (await response.json().catch(() => ({}))) as { id?: string }
        return { ok: true, providerMessageId: body.id ?? null, provider: 'resend' }
      } catch (error) {
        logger.error({ err: error }, 'falha ao falar com o Resend')
        return {
          ok: false,
          providerMessageId: null,
          provider: 'resend',
          permanent: false,
          errorCode: 'NETWORK',
          errorDetail: error instanceof Error ? error.message.slice(0, 400) : 'erro desconhecido',
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/** Sem provedor configurado: registra que havia mensagem a enviar e segue. */
function createLoggingPort(motivo: string): ChannelPort {
  return {
    async isAvailable() {
      return true
    },
    async send(request: SendRequest): Promise<SendResult> {
      logger.warn(
        { motivo, subject: request.subject },
        `${motivo} — mensagem marcada como enviada sem sair de fato`,
      )
      return { ok: true, providerMessageId: null, provider: 'log' }
    },
  }
}

/**
 * O corpo é texto puro, escrito pelo petshop. O HTML existe só para o cliente de
 * e-mail respeitar as quebras de linha — nada de layout, porque quem edita o texto na
 * tela não escreve marcação e não deve precisar.
 */
function renderHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,` +
    `sans-serif;font-size:15px;line-height:1.6;color:#232427">${escaped}</div>`
  )
}

let port: ChannelPort | null = null

export function getEmailPort(): ChannelPort {
  if (port) return port
  const env = loadEnv()
  if (!env.RESEND_API_KEY) {
    port = createLoggingPort('RESEND_API_KEY ausente')
  } else if (!env.MAIL_FROM) {
    // A chave sozinha não envia nada: o Resend recusa qualquer remetente cujo domínio
    // não esteja verificado na conta, e não há padrão que sirva para todo mundo.
    port = createLoggingPort('MAIL_FROM ausente (domínio verificado no Resend)')
  } else {
    port = createResendPort(env.RESEND_API_KEY, env.MAIL_FROM)
  }
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setEmailPort(next: ChannelPort | null): void {
  port = next
}
