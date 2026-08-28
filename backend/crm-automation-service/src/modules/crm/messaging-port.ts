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
  tutorId: string
  petId?: string
  templateKey: string
  dedupeKey: string
  variables: Record<string, string | number>
  channel?: MessageChannelPref
  originType?: MessageOriginType
  originId?: string
  scheduledFor?: Date
}

export interface MessagingPort {
  enqueue(request: EnqueueRequest): Promise<boolean>
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
            tutorId: request.tutorId,
            ...(request.petId ? { petId: request.petId } : {}),
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
          return false
        }

        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          logger.error(
            { status: response.status, templateKey: request.templateKey, detail },
            'messaging-service recusou o enfileiramento',
          )
          return false
        }

        return true
      } catch (error) {
        logger.error({ err: error }, 'falha ao falar com o messaging-service')
        return false
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
