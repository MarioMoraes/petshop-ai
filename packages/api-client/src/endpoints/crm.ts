import {
  AutomationResponseSchema,
  CampaignPreviewSchema,
  CampaignRunSummarySchema,
  CampaignSummarySchema,
  CampaignTargetRowSchema,
  MessageStatsSchema,
  MessageSummarySchema,
  MessagingSettingsResponseSchema,
  PaginatedMessagesSchema,
  ResolvedTemplateSchema,
  SuppressionResponseSchema,
  TemplatePreviewSchema,
  WhatsappConnectionSchema,
  EmailDomainResponseSchema,
  type CreateSuppressionInput,
  type MessageCategory,
  type MessageChannel,
  type MessageRecipientKind,
  type MessageStatus,
  type PreviewTemplateInput,
  type CreateCampaignInput,
  type RunCampaignInput,
  type UpdateAutomationInput,
  type UpdateCampaignInput,
  type UpdateMessagingSettingsInput,
  type UpsertMessageTemplateInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

/**
 * Filtros do histórico. Datas em ISO porque vêm da URL do painel, não de um `Date` —
 * quem monta o link é o navegador do atendente, e o Zod da rota faz a coerção.
 */
export type MessageFilters = {
  page?: number
  limit?: number
  status?: MessageStatus
  channel?: MessageChannel
  category?: MessageCategory
  /** MOD-NOTIF-11: separa o que foi ao cliente do que foi à equipe. */
  recipientKind?: MessageRecipientKind
  templateKey?: string
  from?: string
  to?: string
}

export function crmEndpoints({ request }: Transport) {
  return {
    // ─── MOD-CRM (PRD relacionamento_crm_08 §5) ───────────────────────────────

    listMessages: (query: MessageFilters = {}) =>
      request({
        method: 'GET',
        path: `/v1/messages${toQueryString(query)}`,
        schema: PaginatedMessagesSchema,
      }),

    /**
     * O histórico de um tutor mora sob a ficha dele, não em `/v1/messages?tutorId=`.
     * As duas rotas devolvem o mesmo, mas o gateway roteia por prefixo e este é o
     * endereço que o Portal vai herdar quando puder filtrar por dono.
     */
    listTutorMessages: (tutorId: string, query: MessageFilters = {}) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${tutorId}/messages${toQueryString(query)}`,
        schema: PaginatedMessagesSchema,
      }),

    getMessage: (id: string) =>
      request({ method: 'GET', path: `/v1/messages/${id}`, schema: MessageSummarySchema }),

    /** Sem `from`/`to`, o total de todos os tempos — o painel sempre manda a janela. */
    getMessageStats: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/messages/stats${toQueryString(query)}`,
        schema: MessageStatsSchema,
      }),

    /** Volta a `QUEUED` com o contador zerado, revalidando consentimento (AC-02). */
    retryMessage: (id: string) =>
      request({ method: 'POST', path: `/v1/messages/${id}/retry`, schema: z.unknown() }),

    cancelMessage: (id: string) =>
      request({ method: 'POST', path: `/v1/messages/${id}/cancel`, schema: z.unknown() }),

    listMessageTemplates: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/templates',
        schema: z.object({ data: z.array(ResolvedTemplateSchema) }),
      }),

    /** PUT, não PATCH: o texto é substituído inteiro, nunca remendado. */
    saveMessageTemplate: (
      key: string,
      channel: MessageChannel,
      input: UpsertMessageTemplateInput,
    ) =>
      request({
        method: 'PUT',
        path: `/v1/messaging/templates/${key}/${channel}`,
        body: input,
        schema: ResolvedTemplateSchema,
      }),

    /** Apaga o override e devolve o texto de fábrica. 409 se nunca houve override. */
    resetMessageTemplate: (key: string, channel: MessageChannel) =>
      request({
        method: 'DELETE',
        path: `/v1/messaging/templates/${key}/${channel}`,
        schema: ResolvedTemplateSchema,
      }),

    previewMessageTemplate: (input: PreviewTemplateInput) =>
      request({
        method: 'POST',
        path: '/v1/messaging/templates/preview',
        body: input,
        schema: TemplatePreviewSchema,
      }),

    getMessagingSettings: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/settings',
        schema: MessagingSettingsResponseSchema,
      }),

    updateMessagingSettings: (input: UpdateMessagingSettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/messaging/settings',
        body: input,
        schema: MessagingSettingsResponseSchema,
      }),

    listMessagingSuppressions: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/suppressions',
        schema: z.object({ data: z.array(SuppressionResponseSchema) }),
      }),

    createMessagingSuppression: (input: CreateSuppressionInput) =>
      request({
        method: 'POST',
        path: '/v1/messaging/suppressions',
        body: input,
        schema: z.unknown(),
      }),

    deleteMessagingSuppression: (id: string) =>
      request({
        method: 'DELETE',
        path: `/v1/messaging/suppressions/${id}`,
        schema: z.unknown(),
      }),

    // ─── Domínio de e-mail próprio (Configurações › Integrações) ────────────

    getEmailDomain: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/email-domain',
        schema: EmailDomainResponseSchema,
      }),

    /** Registra o domínio no Resend da plataforma e devolve os registros de DNS. */
    setEmailDomain: (body: { domain: string; localPart?: string }) =>
      request({
        method: 'PUT',
        path: '/v1/messaging/email-domain',
        body,
        schema: EmailDomainResponseSchema,
      }),

    verifyEmailDomain: () =>
      request({
        method: 'POST',
        path: '/v1/messaging/email-domain/verify',
        schema: EmailDomainResponseSchema,
      }),

    removeEmailDomain: () =>
      request({
        method: 'DELETE',
        path: '/v1/messaging/email-domain',
        schema: EmailDomainResponseSchema,
      }),

    // ─── Conexão do WhatsApp (MOD-CRM-01) ───────────────────────────────────
    //
    // `connect` e `qr` devolvem `qrCode`; `getWhatsappConnection` nunca devolve — o QR
    // vence em cerca de um minuto do lado do provedor, e um QR guardado é um QR morto.

    getWhatsappConnection: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/whatsapp',
        schema: WhatsappConnectionSchema,
      }),

    connectWhatsapp: () =>
      request({
        method: 'POST',
        path: '/v1/messaging/whatsapp/connect',
        schema: WhatsappConnectionSchema,
      }),

    refreshWhatsappQrCode: () =>
      request({
        method: 'POST',
        path: '/v1/messaging/whatsapp/qr',
        schema: WhatsappConnectionSchema,
      }),

    /** Recuperação: apaga a instância no provedor e cria outra, com identidade nova. */
    recreateWhatsapp: () =>
      request({
        method: 'POST',
        path: '/v1/messaging/whatsapp/recreate',
        schema: WhatsappConnectionSchema,
      }),

    disconnectWhatsapp: () =>
      request({
        method: 'DELETE',
        path: '/v1/messaging/whatsapp',
        schema: WhatsappConnectionSchema,
      }),

    listAutomations: () =>
      request({
        method: 'GET',
        path: '/v1/crm/automations',
        schema: z.object({ data: z.array(AutomationResponseSchema) }),
      }),

    updateAutomation: (key: string, input: UpdateAutomationInput) =>
      request({
        method: 'PATCH',
        path: `/v1/crm/automations/${key}`,
        body: input,
        schema: AutomationResponseSchema,
      }),

    // ─── MOD-CRM fatia 3 — campanhas ───────────────────────────────────────

    listCampaigns: () =>
      request({
        method: 'GET',
        path: '/v1/crm/campaigns',
        schema: z.object({ data: z.array(CampaignSummarySchema) }),
      }),

    getCampaign: (id: string) =>
      request({ method: 'GET', path: `/v1/crm/campaigns/${id}`, schema: CampaignSummarySchema }),

    createCampaign: (input: CreateCampaignInput) =>
      request({
        method: 'POST',
        path: '/v1/crm/campaigns',
        body: input,
        schema: CampaignSummarySchema,
      }),

    updateCampaign: (id: string, input: UpdateCampaignInput) =>
      request({
        method: 'PATCH',
        path: `/v1/crm/campaigns/${id}`,
        body: input,
        schema: CampaignSummarySchema,
      }),

    /**
     * A prévia é `POST` mesmo sem gravar nada.
     *
     * O segmento é resolvido no instante da chamada, e um `GET` seria cacheado pelo
     * navegador — a segunda prévia devolveria a primeira, que é exatamente a mentira que
     * a confirmação de contagem existe para impedir.
     */
    previewCampaign: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/crm/campaigns/${id}/preview`,
        schema: CampaignPreviewSchema,
      }),

    runCampaign: (id: string, input: RunCampaignInput) =>
      request({
        method: 'POST',
        path: `/v1/crm/campaigns/${id}/run`,
        body: input,
        schema: z.object({
          runId: z.uuid(),
          targeted: z.number().int(),
          sent: z.number().int(),
          skipped: z.number().int(),
          failed: z.number().int(),
        }),
      }),

    cancelCampaign: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/crm/campaigns/${id}/cancel`,
        schema: z.object({ cancelledMessages: z.number().int() }),
      }),

    listCampaignRuns: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/crm/campaigns/${id}/runs`,
        schema: z.object({ data: z.array(CampaignRunSummarySchema) }),
      }),

    listCampaignTargets: (runId: string) =>
      request({
        method: 'GET',
        path: `/v1/crm/runs/${runId}/targets`,
        schema: z.object({ data: z.array(CampaignTargetRowSchema) }),
      }),
  }
}
