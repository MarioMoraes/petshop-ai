import type { FastifyInstance, FastifyRequest } from 'fastify'
import { loadEnv } from '../../../config/env.js'
import { logger } from '../../../shared/logger.js'
import { recordSecurityEvent } from '../../../shared/security-events.js'
import { verifySvixSignature } from '../../../shared/svix.js'
import { unauthorized } from '../errors.js'
import { applyClerkWebhook } from './service.js'

/**
 * `POST /internal/v1/clerk/webhook` — a sincronização de MOD-IDENT-03.
 *
 * Terceira superfície anônima do backend, ao lado dos dois webhooks do MOD-NOTIF, e
 * montada igual à do Resend porque o provedor é o mesmo mecanismo: assinatura Svix
 * sobre o **corpo cru**, e por isso um parser próprio no escopo. O JSON reserializado
 * pelo Fastify tem as mesmas chaves e outros bytes, e a assinatura é dos bytes.
 *
 * O caminho **diverge do PRD**, que diz `POST /v1/webhooks/clerk`: neste repositório
 * webhook de provedor mora sob `/internal/` — o nome diz de onde a chamada nasce, não
 * que ela seja privada — e `/v1` é a superfície autenticada, que o hook de sessão cobre
 * por inteiro. Registrar a rota lá pediria uma exceção no hook; aqui não pede nenhuma.
 *
 * Como o Resend, o Clerk é um serviço na internet: a rota precisa de endereço público
 * (`infra/Caddyfile`) e o que a protege é inteiramente a assinatura.
 */
export async function registerClerkWebhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8')
      ;(request as FastifyRequest & { rawBody?: string }).rawBody = raw
      try {
        done(null, raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        done(error as Error, undefined)
      }
    })

    scope.post('/internal/v1/clerk/webhook', async (request, reply) => {
      const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? ''
      const svixId = request.headers['svix-id'] as string | undefined

      const valid = verifySvixSignature({
        secret: loadEnv().CLERK_WEBHOOK_SECRET,
        headers: {
          id: svixId,
          timestamp: request.headers['svix-timestamp'] as string | undefined,
          signature: request.headers['svix-signature'] as string | undefined,
        },
        rawBody: raw,
      })

      /**
       * 401 sem processar nada, e uma linha em `security_events` (AC-02 de MOD-SEC-07).
       *
       * `tenantId` nulo porque a assinatura era justamente o que diria de quem se trata.
       * O `await` importa: uma requisição recusada responde em milissegundos, e um
       * registro disparado sem espera perderia a corrida com o fim do processo numa
       * réplica encerrando.
       */
      if (!valid) {
        await recordSecurityEvent({
          tenantId: null,
          type: 'WEBHOOK_SIGNATURE_INVALID',
          targetEntity: 'clerk_webhook',
          targetId: svixId ?? null,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        })
        throw unauthorized('Assinatura do webhook inválida')
      }

      // `svix-id` é a identidade da entrega e a chave da idempotência. Assinatura válida
      // sem ele é impossível — ele entra no conteúdo assinado —, mas o serviço não
      // depende dessa dedução.
      if (!svixId) throw unauthorized('Assinatura do webhook inválida')

      const result = await applyClerkWebhook(
        request.body as Parameters<typeof applyClerkWebhook>[0],
        svixId,
      )

      if (result.outcome !== 'PROCESSED') {
        logger.debug({ svixId, ...result }, 'webhook do Clerk sem efeito')
      }

      /**
       * 204 inclusive para o que foi ignorado ou falhou sem remédio. O Clerk reentrega o
       * que não recebe 2xx, e insistir num evento que nenhuma reentrega resolve encheria
       * a fila dele para sempre — o desfecho está na linha de `webhook_events`, que é
       * onde a plataforma o lê.
       */
      return reply.status(204).send()
    })
  })
}
