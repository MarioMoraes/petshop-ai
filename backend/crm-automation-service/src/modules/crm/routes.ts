import {
  CreateCampaignSchema,
  RunCampaignSchema,
  UpdateAutomationSchema,
  UpdateCampaignSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from '../../auth/context.js'
import { notFound } from '../../lib/errors.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from './actor.js'
import { listAutomations, updateAutomation } from './automations.js'
import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  listRuns,
  listTargets,
  previewCampaign,
  runCampaign,
  updateCampaign,
} from './campaigns.js'

/**
 * Rotas do crm-automation-service (§5 do PRD).
 *
 * A separação de permissões segue a do módulo: `crm:read` vê, `crm:configure` mexe nas
 * automações e `crm:send` **dispara**. As três são distintas de propósito — quem
 * configura a régua de cobrança não é necessariamente quem pode mandar uma campanha para
 * a base inteira, e a segunda decisão é irreversível.
 *
 * A prévia exige `crm:send`, e não `crm:read`, mesmo sem enviar nada: ela devolve uma
 * amostra de nomes de quem receberia, que é informação de quem vai disparar.
 */

interface KeyParams {
  key: string
}

interface IdParams {
  id: string
}

interface RunParams {
  runId: string
}

/**
 * Um id de rota que não é UUID é 404, não 500.
 *
 * Sem esta guarda o valor chega ao Prisma, que estoura com erro de tipo de coluna e cai
 * no 500 genérico — o log ganha uma pilha de banco de dados por causa de um endereço
 * digitado errado, e quem lê o log procura um defeito que não existe.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireUuid(value: string, what: string): string {
  if (!UUID.test(value)) throw notFound(`${what} não encontrada`)
  return value
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

  // ─── Campanhas (MOD-CRM-07 e MOD-CRM-12) ───────────────────────────────────

  app.get(
    '/v1/crm/campaigns',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as campanhas') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { data: await listCampaigns(auth.tenantId) }
    },
  )

  app.get<{ Params: IdParams }>(
    '/v1/crm/campaigns/:id',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as campanhas') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getCampaign(auth.tenantId, requireUuid(request.params.id, 'Campanha'))
    },
  )

  app.post(
    '/v1/crm/campaigns',
    { preHandler: requirePermission('crm:send', 'Você não tem permissão para criar campanhas') },
    async (request, reply) => {
      const input = parseInput(CreateCampaignSchema, request.body)
      const campaign = await createCampaign(actorOf(request), input)
      return reply.status(201).send(campaign)
    },
  )

  app.patch<{ Params: IdParams }>(
    '/v1/crm/campaigns/:id',
    { preHandler: requirePermission('crm:send', 'Você não tem permissão para editar campanhas') },
    async (request) => {
      const input = parseInput(UpdateCampaignSchema, request.body)
      return updateCampaign(actorOf(request), requireUuid(request.params.id, 'Campanha'), input)
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/crm/campaigns/:id/preview',
    { preHandler: requirePermission('crm:send', 'Você não tem permissão para ver a prévia') },
    async (request) => {
      const auth = requireTenantContext(request)
      return previewCampaign(auth.tenantId, requireUuid(request.params.id, 'Campanha'))
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/crm/campaigns/:id/run',
    { preHandler: requirePermission('crm:send', 'Você não tem permissão para disparar campanhas') },
    async (request) => {
      const input = parseInput(RunCampaignSchema, request.body)
      return runCampaign(actorOf(request), requireUuid(request.params.id, 'Campanha'), input.expectedTargets)
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/crm/campaigns/:id/cancel',
    { preHandler: requirePermission('crm:send', 'Você não tem permissão para cancelar campanhas') },
    async (request) => {
      const cancelled = await cancelCampaign(actorOf(request), requireUuid(request.params.id, 'Campanha'))
      return { cancelledMessages: cancelled }
    },
  )

  app.get<{ Params: IdParams }>(
    '/v1/crm/campaigns/:id/runs',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as campanhas') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { data: await listRuns(auth.tenantId, requireUuid(request.params.id, 'Campanha')) }
    },
  )

  app.get<{ Params: RunParams }>(
    '/v1/crm/runs/:runId/targets',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as campanhas') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { data: await listTargets(auth.tenantId, requireUuid(request.params.runId, 'Execução')) }
    },
  )
}
