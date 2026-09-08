import { signServiceHeaders } from '@petshop/service-auth'
import type { MessageChannelPref, MessageOriginType } from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'

/**
 * A porta para o messaging-service — o primeiro salto HTTP serviço→serviço do sistema.
 *
 * O contexto assinado é montado aqui, com o mesmo HMAC que o gateway usa, e **sem
 * `userId`**: quem pediu foi uma automação, não uma pessoa, e a trilha do outro lado
 * precisa dizer isso em vez de atribuir o envio a quem por acaso criou o agendamento.
 *
 * `enqueue` **nunca lança**. Uma automação que estoura porque o messaging está fora
 * derrubaria o consumidor de evento inteiro — e o evento seguinte, de outro tenant,
 * junto. O retorno booleano deixa o chamador contar as falhas e seguir; a varredura da
 * hora seguinte reenfileira o que faltou, e o `dedupeKey` impede a duplicata.
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

const REQUEST_TIMEOUT_MS = 5_000

function createHttpPort(): MessagingPort {
  return {
    async enqueue(request) {
      const env = loadEnv()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      try {
        const headers = signServiceHeaders(
          {
            clerkUserId: 'svc_crm-automation',
            tenantId: request.tenantId,
            permissions: [],
          },
          env.INTERNAL_SERVICE_SECRET,
        )

        const response = await fetch(`${env.MESSAGING_SERVICE_URL}/v1/messages`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
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
            ...(request.scheduledFor ? { scheduledFor: request.scheduledFor.toISOString() } : {}),
          }),
          signal: controller.signal,
        })

        if (response.status === 409) {
          // Motor desligado neste tenant. É configuração, não falha — e logar como
          // erro encheria o log de todo tenant que não usa mensagens.
          logger.debug({ tenantId: request.tenantId }, 'mensagens desligadas no tenant')
          return null
        }

        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          logger.error(
            { status: response.status, templateKey: request.templateKey, detail },
            'messaging-service recusou o enfileiramento',
          )
          return null
        }

        const body = (await response.json()) as {
          id?: unknown
          status?: unknown
          blockReason?: unknown
        }

        return {
          messageId: typeof body.id === 'string' ? body.id : '',
          status: typeof body.status === 'string' ? body.status : 'QUEUED',
          blockReason: typeof body.blockReason === 'string' ? body.blockReason : null,
        }
      } catch (error) {
        logger.error({ err: error }, 'falha ao falar com o messaging-service')
        return null
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

let port: MessagingPort | null = null

export function getMessagingPort(): MessagingPort {
  port ??= createHttpPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setMessagingPort(next: MessagingPort | null): void {
  port = next
}
