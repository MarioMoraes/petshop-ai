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

export interface SendRequest {
  /** Quem está enviando. É por ele que o WhatsApp acha a instância e a chave dela. */
  tenantId: string
  to: string
  subject: string | null
  body: string
  senderName: string | null
  replyTo: string | null
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
