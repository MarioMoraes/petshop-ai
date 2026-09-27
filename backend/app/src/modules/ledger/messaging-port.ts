import { EnqueueMessageSchema } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { enqueueMessage } from '../messaging/messages.js'

/**
 * A porta do MOD-LEDGER para o MOD-NOTIF — um método só: mandar o link de pagamento.
 *
 * Passa pelo mesmo `EnqueueMessageSchema` da rota `POST /v1/messages`, pela razão que o
 * CLAUDE.md registra: o schema preenche os defaults do contrato, e a chamada direta os
 * pularia. O ator é o da recepção que pediu o envio — é uma pessoa mandando uma cobrança,
 * não uma automação.
 *
 * `false` é "não saiu" (motor desligado, tutor sem canal): quem chama devolve o link à
 * tela para a recepção copiar, e o erro nunca desfaz a cobrança já criada.
 */

export interface ChargeLinkMessage {
  tenantId: string
  tutorId: string
  chargeId: string
  variables: Record<string, string>
}

export interface LedgerMessagingPort {
  sendChargeLink(message: ChargeLinkMessage): Promise<boolean>
}

function createInProcessPort(): LedgerMessagingPort {
  return {
    async sendChargeLink(message) {
      try {
        const input = EnqueueMessageSchema.parse({
          tutorId: message.tutorId,
          templateKey: 'tutor_charge_link',
          dedupeKey: `tutor-charge:${message.chargeId}`,
          variables: message.variables,
          originType: 'MANUAL',
          originId: message.chargeId,
        })
        const result = await enqueueMessage({ tenantId: message.tenantId }, input)
        return result.status !== 'BLOCKED' && result.status !== 'CANCELLED'
      } catch (error) {
        logger.warn({ err: error, tenantId: message.tenantId }, 'link de pagamento não enfileirou')
        return false
      }
    },
  }
}

let port: LedgerMessagingPort | null = null

export function getLedgerMessagingPort(): LedgerMessagingPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setLedgerMessagingPort(next: LedgerMessagingPort | null): void {
  port = next
}
