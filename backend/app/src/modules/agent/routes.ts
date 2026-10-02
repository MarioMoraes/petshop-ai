import {
  AgentConversationListQuerySchema,
  AgentReplySchema,
  AgentStatsQuerySchema,
  SetAgentApiKeySchema,
  UpdateAgentSettingsSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from './auth.js'
import { notFound } from './errors.js'
import { parseInput } from './validate.js'
import type { ActorContext } from './actor.js'
import { findConversation, listConversations } from './queries.js'
import { assignConversation, closeConversation, replyToConversation } from './service.js'
import { removeApiKey, setApiKey } from './api-key.js'
import { getSettings, updateSettings } from './settings.js'
import { readStats } from './stats.js'

/**
 * Rotas do MOD-AI (§5 do PRD agentes_ia_15).
 *
 * **O agente não tem superfície pública**: quem o aciona é o webhook da Evolution, que já
 * existe sob `/internal/` e se autentica com o token da instância. Tudo o que está aqui é
 * da equipe.
 *
 * As permissões reusam as do CRM — o §9 do PRD é explícito em não criar nenhuma: o agente
 * é uma forma de o CRM falar, e o recorte de quem opera CRM já está na matriz.
 *
 * **Uma divergência consciente do §5.** A tabela de endpoints põe `crm:send` em
 * `/reply`, mas a tabela de controle de acesso do §9, no mesmo PRD, dá "assumir e
 * responder" ao `RECEPTIONIST` — que não tem `crm:send` na matriz, e não tem de
 * propósito: `crm:send` é disparar campanha para a base inteira, que é decisão
 * irreversível de administrador. Responder a um cliente que escreveu primeiro é o
 * trabalho da recepção. As três escritas ficam com `crm:manage`, que é o que a recepção
 * tem — a alternativa seria uma fila que ela vê e não pode atender.
 */

interface IdParams {
  id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Id que não é UUID é 404, não 500: endereço digitado errado não é defeito de banco. */
function requireUuid(value: string): string {
  if (!UUID.test(value)) throw notFound()
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

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/agent/conversations',
    {
      preHandler: requirePermission('crm:read', 'Você não tem permissão para ver os atendimentos'),
    },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(AgentConversationListQuerySchema, request.query)
      return listConversations(auth.tenantId, query)
    },
  )

  app.get<{ Params: IdParams }>(
    '/v1/agent/conversations/:id',
    {
      preHandler: requirePermission('crm:read', 'Você não tem permissão para ver os atendimentos'),
    },
    async (request) => {
      const auth = requireTenantContext(request)
      return findConversation(auth.tenantId, requireUuid(request.params.id))
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/agent/conversations/:id/assign',
    { preHandler: requirePermission('crm:manage', 'Você não tem permissão para atender') },
    async (request, reply) => {
      await assignConversation(actorOf(request), requireUuid(request.params.id))
      return reply.status(204).send()
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/agent/conversations/:id/reply',
    { preHandler: requirePermission('crm:manage', 'Você não tem permissão para responder') },
    async (request, reply) => {
      const input = parseInput(AgentReplySchema, request.body)
      await replyToConversation(actorOf(request), requireUuid(request.params.id), input)
      return reply.status(204).send()
    },
  )

  /**
   * A configuração do agente (MOD-AI-07).
   *
   * Ler é `crm:read` — a recepção precisa saber se o atendimento automático está ligado
   * para entender por que a fila está cheia ou vazia. **Mexer é `crm:configure`**, que a
   * recepção não tem: ligar um robô que fala em nome do petshop e definir quanto ele pode
   * gastar por mês são decisões de administrador.
   */
  app.get(
    '/v1/agent/settings',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver a configuração') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getSettings(auth.tenantId)
    },
  )

  app.patch(
    '/v1/agent/settings',
    {
      preHandler: requirePermission(
        'crm:configure',
        'Você não tem permissão para configurar o atendimento automático',
      ),
    },
    async (request) => {
      const input = parseInput(UpdateAgentSettingsSchema, request.body)
      return updateSettings(actorOf(request), input)
    },
  )

  /**
   * A chave do Google Gemini do estabelecimento (Configurações › Integrações).
   *
   * `tenant:configure`, e não `crm:configure`: a chave é um contrato de pagamento com um
   * terceiro, do mesmo peso da assinatura — quem configura o atendimento não é
   * necessariamente quem responde pela conta. Devolve a configuração inteira, porque a
   * tela precisa do estado novo (`providerConfigured`) e não só do "deu certo".
   */
  app.put(
    '/v1/agent/api-key',
    {
      preHandler: requirePermission(
        'tenant:configure',
        'Cadastrar a chave do Gemini é uma ação do administrador do estabelecimento',
      ),
    },
    async (request) => {
      const input = parseInput(SetAgentApiKeySchema, request.body)
      const actor = actorOf(request)
      await setApiKey(actor, input)
      return getSettings(actor.tenantId)
    },
  )

  app.delete(
    '/v1/agent/api-key',
    {
      preHandler: requirePermission(
        'tenant:configure',
        'Remover a chave do Gemini é uma ação do administrador do estabelecimento',
      ),
    },
    async (request) => {
      const actor = actorOf(request)
      await removeApiKey(actor)
      return getSettings(actor.tenantId)
    },
  )

  /**
   * O painel de qualidade (MOD-AI-09).
   *
   * `crm:read`, e não `crm:configure`: o §9 do PRD dá "ver o painel de qualidade" ao
   * `RECEPTIONIST` junto do `TENANT_ADMIN`. Quem atende a fila é quem primeiro percebe
   * que o agente parou de resolver, e uma métrica que só o dono enxerga chega tarde.
   */
  app.get(
    '/v1/agent/stats',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver o painel') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(AgentStatsQuerySchema, request.query)
      return readStats(auth.tenantId, query)
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/agent/conversations/:id/close',
    { preHandler: requirePermission('crm:manage', 'Você não tem permissão para encerrar') },
    async (request, reply) => {
      await closeConversation(actorOf(request), requireUuid(request.params.id))
      return reply.status(204).send()
    },
  )
}
