import type { MessageChannel } from '@petshop/shared-types'
import { getEmailPort } from './email.js'
import { getWhatsAppPort } from './whatsapp.js'

/**
 * Onde os canais são escolhidos — o ponto de troca de provedor.
 *
 * A fatia 1 entrega **só e-mail**. O WhatsApp existe aqui como porta declarada e
 * indisponível, e não como código ausente, por uma razão concreta: assim a cascata de
 * `AUTO` já exercita a queda de canal hoje, com teste, em vez de estrear no dia em que
 * a Evolution API entrar. Ligar a fatia 2 é implementar `WhatsAppPort` e devolver
 * `available: true`.
 */

export interface SendRequest {
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
  readonly available: boolean
  send(request: SendRequest): Promise<SendResult>
}

export function portFor(channel: MessageChannel): ChannelPort {
  return channel === 'EMAIL' ? getEmailPort() : getWhatsAppPort()
}

export function channelAvailable(channel: MessageChannel): boolean {
  return portFor(channel).available
}
