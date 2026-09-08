import {
  AppError,
  EnqueueMessageSchema,
  type MessageChannelPref,
  type MessageOriginType,
} from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { MESSAGING_DISABLED_CODE } from '../messaging/errors.js'
import { enqueueMessage } from '../messaging/messages.js'

/**
 * A porta para o MOD-NOTIF.
 *
 * Era um salto HTTP serviço→serviço — o primeiro do sistema. Com os dois módulos no
 * mesmo processo virou chamada de função: o `enqueueMessage` é o mesmo que a rota
 * `POST /v1/messages` executa, e o corte de responsabilidade que motivou o salto
 * continua de pé — este módulo decide **quem e quando**, aquele sabe **como entregar**.
 * O que sumiu foi a serialização, o HMAC e o timeout de rede no meio.
 *
 * O ator vai **sem `actorUserId`**: quem pediu foi uma automação, não uma pessoa, e a
 * trilha precisa dizer isso em vez de atribuir o envio a quem por acaso criou o
 * agendamento.
 *
 * `enqueue` **nunca lança**. Uma automação que estoura derrubaria o consumidor de
 * evento inteiro — e o evento seguinte, de outro tenant, junto. O `null` deixa o
 * chamador contar as falhas e seguir; a varredura da hora seguinte reenfileira o que
 * faltou, e o `dedupeKey` impede a duplicata.
 */

export interface EnqueueRequest {
  tenantId: string
  /**
   * A quem se fala. `TUTOR` por omissão, que é o que toda automação anterior ao
   * MOD-NOTIF manda — e o que mantém `tutorId` obrigatório na prática para elas.
   */
  recipientKind?: 'TUTOR' | 'USER'
  tutorId?: string
  /** O membro da equipe (MOD-NOTIF-01). Exatamente um entre este e `tutorId`. */
  userId?: string
  petId?: string
  /** O documento que viaja anexo (MOD-NOTIF-05). Referência, nunca conteúdo. */
  documentId?: string
  templateKey: string
  dedupeKey: string
  variables: Record<string, string | number>
  channel?: MessageChannelPref
  originType?: MessageOriginType
  originId?: string
  scheduledFor?: Date
}

/**
 * O que o motor respondeu.
 *
 * Era um `boolean` até a fatia 3. A campanha é que exigiu mais: `campaign_targets`
 * guarda o id da mensagem e o motivo de quem ficou de fora, e um "deu certo / não deu"
 * não distingue "o tutor revogou o marketing" de "o messaging-service está fora do ar" —
 * a primeira é informação para a tela, a segunda é incidente.
 *
 * `null` continua sendo "não consegui", e é por isso que todo chamador antigo segue
 * válido: `if (ok)` funciona igual sobre um objeto.
 */
export interface EnqueueOutcome {
  messageId: string
  status: string
  blockReason: string | null
}

export interface MessagingPort {
  enqueue(request: EnqueueRequest): Promise<EnqueueOutcome | null>
}

function createInProcessPort(): MessagingPort {
  return {
    async enqueue(request) {
      try {
        /**
         * **Passa pelo mesmo schema que a rota usa**, e não direto ao `enqueueMessage`.
         *
         * `EnqueueMessageSchema` não só valida: ele preenche `recipientKind`, `channel`
         * e `urgent` com os defaults do contrato. Montar o objeto à mão aqui faria a
         * automação enfileirar com um recorte diferente do que a mesma chamada por HTTP
         * produzia — a diferença que o salto de rede escondia atrás da serialização.
         */
        const input = EnqueueMessageSchema.parse({
          ...(request.recipientKind ? { recipientKind: request.recipientKind } : {}),
          ...(request.tutorId ? { tutorId: request.tutorId } : {}),
          ...(request.userId ? { userId: request.userId } : {}),
          ...(request.petId ? { petId: request.petId } : {}),
          ...(request.documentId ? { documentId: request.documentId } : {}),
          templateKey: request.templateKey,
          dedupeKey: request.dedupeKey,
          variables: request.variables,
          ...(request.channel ? { channel: request.channel } : {}),
          ...(request.originType ? { originType: request.originType } : {}),
          ...(request.originId ? { originId: request.originId } : {}),
          ...(request.scheduledFor ? { scheduledFor: request.scheduledFor } : {}),
        })

        const result = await enqueueMessage({ tenantId: request.tenantId }, input)

        return {
          messageId: result.id,
          status: result.status,
          blockReason: result.blockReason ?? null,
        }
      } catch (error) {
        if (error instanceof AppError && error.code === MESSAGING_DISABLED_CODE) {
          logger.debug({ tenantId: request.tenantId }, 'mensagens desligadas no tenant')
          return null
        }
        logger.error({ err: error, templateKey: request.templateKey }, 'falha ao enfileirar')
        return null
      }
    },
  }
}

let port: MessagingPort | null = null

export function getMessagingPort(): MessagingPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setMessagingPort(next: MessagingPort | null): void {
  port = next
}
