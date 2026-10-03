import {
  type AgentConversationStatus,
  AgentConversationDetailSchema,
  AgentSettingsSchema,
  AgentStatsSchema,
  type AgentTone,
  PaginatedAgentConversationsSchema,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function agentEndpoints({ request }: Transport) {
  return {
    // ─── MOD-AI (PRD agentes_ia_15 §5) ────────────────────────────────────────

    /**
     * A fila de atendimento e o histórico das conversas.
     *
     * `waitingOverMinutes` é o recorte do sino: ele precisa do **total** de quem espera
     * há mais de dez minutos, e somar isso a partir de uma página daria o número da
     * página, não o da fila.
     */
    listAgentConversations: (
      query: {
        status?: AgentConversationStatus
        waitingOverMinutes?: number
        page?: number
        limit?: number
      } = {},
    ) =>
      request({
        method: 'GET',
        path: `/v1/agent/conversations${toQueryString(query)}`,
        schema: PaginatedAgentConversationsSchema,
      }),

    getAgentConversation: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/agent/conversations/${id}`,
        schema: AgentConversationDetailSchema,
      }),

    assignAgentConversation: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/agent/conversations/${id}/assign`,
        schema: z.unknown(),
      }),

    replyAgentConversation: (id: string, text: string) =>
      request({
        method: 'POST',
        path: `/v1/agent/conversations/${id}/reply`,
        body: { text },
        schema: z.unknown(),
      }),

    closeAgentConversation: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/agent/conversations/${id}/close`,
        schema: z.unknown(),
      }),

    getAgentSettings: () =>
      request({ method: 'GET', path: '/v1/agent/settings', schema: AgentSettingsSchema }),

    /** PATCH e não PUT: a tela manda só o que mudou, e o servidor não reescreve o resto. */
    updateAgentSettings: (body: {
      enabled?: boolean
      opensAt?: string
      closesAt?: string
      monthlyCapCents?: number
      /** `null` apaga o nome da persona; ausente o deixa como está. */
      personaName?: string | null
      tone?: AgentTone
    }) =>
      request({
        method: 'PATCH',
        path: '/v1/agent/settings',
        body,
        schema: AgentSettingsSchema,
      }),

    /**
     * A chave do Google Gemini do estabelecimento. O servidor a confere no Google antes de
     * gravar, e devolve a configuração inteira — só os quatro últimos caracteres voltam.
     */
    setAgentApiKey: (apiKey: string) =>
      request({
        method: 'PUT',
        path: '/v1/agent/api-key',
        body: { apiKey },
        schema: AgentSettingsSchema,
      }),

    removeAgentApiKey: () =>
      request({ method: 'DELETE', path: '/v1/agent/api-key', schema: AgentSettingsSchema }),

    /**
     * O painel de qualidade (MOD-AI-09).
     *
     * A janela vai como **instante**, e não como data civil: o painel é do mês do
     * estabelecimento, e quem converte um para o outro é a página, com o fuso do tenant
     * — a mesma divisão de trabalho do painel de entregas.
     */
    getAgentStats: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/agent/stats${toQueryString(query)}`,
        schema: AgentStatsSchema,
      }),
  }
}
