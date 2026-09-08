import type { MessageChannel } from '@petshop/shared-types'
import { getEmailPort } from './email.js'
import { getWhatsAppPort } from './whatsapp.js'

/**
 * Onde os canais são escolhidos — o ponto de troca de provedor.
 *
 * **A disponibilidade é uma pergunta por tenant, não por processo.** Foi assim que
 * esta interface mudou na fatia 2: enquanto o único canal era o e-mail, um booleano de
 * módulo bastava — ou a instalação tem `RESEND_API_KEY`, ou não tem, e vale para todo
 * mundo. O WhatsApp não é assim: o petshop A pareou o número dele, o B não, e os dois
 * rodam no mesmo processo. Um booleano compartilhado responderia "sim" para quem nunca
 * conectou, e a mensagem falharia no provedor em vez de cair para o e-mail.
 */

/**
 * O arquivo que viaja junto (MOD-NOTIF-05).
 *
 * Já resolvido em bytes quando chega aqui: quem decide entre anexar e mandar link é o
 * `attachments.ts`, no despacho, e o adaptador só obedece. É o que mantém a regra do
 * RN-06 num lugar só — o WhatsApp nunca recebe `attachment` preenchido.
 */
export interface SendAttachment {
  filename: string
  content: Buffer
}

export interface SendRequest {
  /** Quem está enviando. É por ele que o WhatsApp acha a instância e a chave dela. */
  tenantId: string
  to: string
  subject: string | null
  body: string
  senderName: string | null
  replyTo: string | null
  attachment?: SendAttachment | null
  /**
   * O corpo em HTML, quando o texto é do **produto** (MOD-NOTIF-04).
   *
   * Ausente para o texto do petshop, que continua saindo com o embrulho mínimo que o
   * próprio adaptador monta. Quem decide entre os dois moldes é o despacho, olhando o
   * `authored` do template — o adaptador não sabe o que é marca.
   *
   * O WhatsApp ignora o campo: lá o corpo é texto, e sempre foi.
   */
  html?: string | null
}

export interface SendResult {
  ok: boolean
  providerMessageId: string | null
  provider: string
  /** Erro **permanente**: não adianta tentar de novo (endereço inválido, bloqueado). */
  permanent?: boolean
  errorCode?: string
  errorDetail?: string
}

export interface ChannelPort {
  isAvailable(tenantId: string): Promise<boolean>
  send(request: SendRequest): Promise<SendResult>
}

export function portFor(channel: MessageChannel): ChannelPort {
  return channel === 'EMAIL' ? getEmailPort() : getWhatsAppPort()
}

export function channelAvailable(channel: MessageChannel, tenantId: string): Promise<boolean> {
  return portFor(channel).isAvailable(tenantId)
}
