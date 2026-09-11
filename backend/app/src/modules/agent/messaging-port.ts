import { EnqueueMessageSchema } from '@petshop/shared-types'
import { enqueueMessage } from '../messaging/messages.js'
import type { ActorContext } from './actor.js'

/**
 * A porta para o MOD-NOTIF (RN-15).
 *
 * **A resposta da recepção sai pelo motor, e não pela Evolution.** O caminho curto — este
 * módulo chamando o provedor direto, já que tem a instância do tenant à mão — pularia a
 * fila, o teto de vazão do aquecimento, a supressão, o histórico e o retorno de entrega.
 * Seriam duas saídas de WhatsApp no produto, e a segunda sem nenhuma das garantias da
 * primeira.
 *
 * A diferença para a porta do Portal é o tratamento da falha: lá ela vira log, porque a
 * resposta pública precisa ser igual nos dois casos. Aqui ela **sobe**. Quem apertou
 * "responder" está olhando para a tela esperando a mensagem aparecer na conversa, e um
 * envio que falha em silêncio é um cliente que fica sem resposta com a recepção achando
 * que respondeu.
 */

export interface ReplyRequest {
  actor: ActorContext
  tutorId: string
  conversationId: string
  text: string
  dedupeKey: string
}

export interface AgentMessagingPort {
  sendReply(request: ReplyRequest): Promise<string>
}

function createInProcessPort(): AgentMessagingPort {
  return {
    async sendReply(request) {
      /**
       * **Passa pelo mesmo schema que a rota usa.** Ele não só valida: preenche
       * `recipientKind`, `variables` e `urgent` com os defaults do contrato — a
       * diferença que a serialização do salto de rede escondia.
       */
      const input = EnqueueMessageSchema.parse({
        tutorId: request.tutorId,
        templateKey: 'agent_reply',
        // Explícito: quem escreveu foi pelo WhatsApp, e a resposta vai pelo mesmo
        // caminho. `AUTO` poderia mandar por e-mail a resposta de uma conversa de
        // WhatsApp, que é o tipo de coisa que faz o cliente achar que ninguém leu.
        channel: 'WHATSAPP',
        variables: { mensagem: request.text },
        dedupeKey: request.dedupeKey,
        originType: 'AGENT_HANDOFF',
        originId: request.conversationId,
        /**
         * A resposta a quem acabou de escrever não espera o tique do worker, e não é
         * agrupada dentro de outra mensagem. Quem está do outro lado está com o celular
         * na mão.
         */
        urgent: true,
      })

      const result = await enqueueMessage(request.actor, input)
      return result.id
    },
  }
}

let port: AgentMessagingPort | null = null

export function getAgentMessagingPort(): AgentMessagingPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setAgentMessagingPort(next: AgentMessagingPort | null): void {
  port = next
}
