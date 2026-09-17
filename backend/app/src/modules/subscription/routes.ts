import { ChangeSubscriptionPlanSchema, StartCheckoutSchema } from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { recordSecurityEvent } from '../../shared/security-events.js'
import { requirePermission, requireTenantContext } from './auth.js'
import { unauthorized } from './errors.js'
import { changePlan, getSubscription, startCheckout, type SubscriptionActor } from './service.js'
import { parseInput } from './validate.js'
import { applyAsaasWebhook, isValidAsaasToken, type AsaasWebhookPayload } from './webhook.js'

/**
 * As rotas da assinatura (camada comercial, fatia 4).
 *
 * **`tenant:configure`, que só o administrador tem.** Assinar é contrair uma despesa em
 * nome do estabelecimento; a recepção vê o aviso de atraso no topo e é mandada falar com
 * quem administra.
 *
 * `/v1/subscription` é o prefixo que a sessão deixa passar quando o estabelecimento está
 * só em leitura (`BILLING_PREFIX` em `auth/session.ts`) — mudar um sem o outro prenderia
 * quem precisa pagar do lado de fora.
 */

const ADMIN = { preHandler: requirePermission('tenant:configure') }

function actorOf(request: FastifyRequest): SubscriptionActor {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export async function registerSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/subscription', ADMIN, async (request) =>
    getSubscription(requireTenantContext(request).tenantId),
  )

  app.post('/v1/subscription/checkout', ADMIN, async (request, reply) => {
    const input = parseInput(StartCheckoutSchema, request.body)
    return reply.status(201).send(await startCheckout(actorOf(request), input))
  })

  app.post('/v1/subscription/plan', ADMIN, async (request) => {
    const input = parseInput(ChangeSubscriptionPlanSchema, request.body)
    return changePlan(actorOf(request), input)
  })
}

/**
 * O webhook do Asaas, fora do escopo autenticado — quem o autentica é o token dele.
 *
 * Sob `/internal/`, que o `app.ts` libera do hook de sessão, e publicado pela borda
 * (`infra/Caddyfile`), como o do Resend.
 */
export async function registerAsaasWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/v1/asaas/webhook', async (request, reply) => {
    const token = request.headers['asaas-access-token']
    if (!isValidAsaasToken(Array.isArray(token) ? token[0] : token)) {
      await recordSecurityEvent({
        tenantId: null,
        type: 'WEBHOOK_SIGNATURE_INVALID',
        targetEntity: 'asaas_webhook',
        targetId: null,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      })
      throw unauthorized('Token do webhook inválido')
    }

    await applyAsaasWebhook((request.body ?? {}) as AsaasWebhookPayload)
    // 200 também para o que ignoramos: o Asaas pausa a fila depois de 15 falhas seguidas,
    // e um evento que não nos interessa não pode travar os que interessam.
    return reply.status(200).send({ received: true })
  })
}
