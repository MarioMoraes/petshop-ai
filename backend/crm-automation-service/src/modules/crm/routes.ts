import { UpdateAutomationSchema } from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from '../../auth/context.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from './actor.js'
import { listAutomations, updateAutomation } from './automations.js'

/**
 * Rotas do crm-automation-service (§5 do PRD).
 *
 * A fatia 1 expõe só as automações. Campanhas (MOD-CRM-07, 08 e 12) entram na fatia 3,
 * e as rotas delas não existem ainda de propósito — endpoint que responde 501 é dívida
 * que ninguém cobra.
 */

interface KeyParams {
  key: string
}

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export async function registerCrmRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/crm/automations',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as automações') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { data: await listAutomations(auth.tenantId) }
    },
  )

  app.patch<{ Params: KeyParams }>(
    '/v1/crm/automations/:key',
    {
      preHandler: requirePermission(
        'crm:configure',
        'Você não tem permissão para configurar as automações',
      ),
    },
    async (request) => {
      const input = parseInput(UpdateAutomationSchema, request.body)
      return updateAutomation(actorOf(request), request.params.key, input)
    },
  )
}
