import {
  PlanSchema,
  type ChangeTenantPlanInput,
  type Plan,
  type UpdatePlanPriceInput,
  SupportGrantResponseSchema,
  PlatformAdminResponseSchema,
  PlatformAdminsResponseSchema,
  PlanPriceAdminRowSchema,
  PlanPricesResponseSchema,
  PlatformAlertsResponseSchema,
  PlatformAuditPageSchema,
  PlatformHealthSchema,
  PlatformMetricSeriesSchema,
  PlatformTenantPageSchema,
  TenantUsageSchema,
  type PlatformAlertQuery,
  type PlatformAuditQuery,
  type PlatformMetricsQuery,
  type TenantListQuery,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function platformEndpoints({ request }: Transport) {
  return {
    // ─── Console da plataforma (MOD-ADMIN, `/platform/v1`) ─────────────────

    /*
     * O outro prefixo do produto que não é `/v1`.
     *
     * Estes nove métodos só respondem a quem apresenta token **sem Organization** e tem
     * linha viva em `platform_admins`; para todo o resto do mundo a superfície inteira é
     * 404, e é assim de propósito (RN-01). Quem chama é o console em `/plataforma`, que
     * roda no mesmo processo Next do Admin e usa este mesmo cliente — o que muda é a
     * sessão que o token carrega, não o transporte.
     */

    listPlatformAdmins: () =>
      request({
        method: 'GET',
        path: '/platform/v1/admins',
        schema: PlatformAdminsResponseSchema,
      }),

    /** O e-mail é o que a pessoa sabe dizer; o servidor o converte em hash para procurar. */
    grantPlatformAdmin: (email: string) =>
      request({
        method: 'POST',
        path: '/platform/v1/admins',
        body: { email },
        schema: PlatformAdminResponseSchema,
      }),

    revokePlatformAdmin: (id: string) =>
      request<void>({ method: 'DELETE', path: `/platform/v1/admins/${id}` }),

    /**
     * A tabela de preços (camada comercial).
     *
     * O que se grava aqui vale para quem assina a partir de agora. Quem já assina tem o
     * valor congelado na própria assinatura — ver `subscription.priceCents`.
     */
    listPlanPrices: () =>
      request({
        method: 'GET',
        path: '/platform/v1/plans',
        schema: PlanPricesResponseSchema,
      }),

    updatePlanPrice: (plan: Plan, input: UpdatePlanPriceInput) =>
      request({
        method: 'PUT',
        path: `/platform/v1/plans/${plan}`,
        body: input,
        schema: PlanPriceAdminRowSchema,
      }),

    /** Voltar ao padrão do código, que é apagar a linha. */
    resetPlanPrice: (plan: Plan) =>
      request({
        method: 'DELETE',
        path: `/platform/v1/plans/${plan}`,
        schema: PlanPriceAdminRowSchema,
      }),

    listPlatformTenants: (query: Partial<TenantListQuery> = {}) =>
      request({
        method: 'GET',
        path: `/platform/v1/tenants${toQueryString(query)}`,
        schema: PlatformTenantPageSchema,
      }),

    /**
     * As contagens de um estabelecimento (MOD-ADMIN-07).
     *
     * A lista já traz as mesmas seis, resolvidas em seis `groupBy`. Esta rota existe para
     * a ficha de um só — e continua sendo contagem: nenhum campo daqui identifica ninguém.
     */
    getPlatformTenantUsage: (tenantId: string) =>
      request({
        method: 'GET',
        path: `/platform/v1/tenants/${tenantId}/usage`,
        schema: TenantUsageSchema,
      }),

    /** Sempre 200: dependência fora do ar é linha vermelha no corpo, nunca erro HTTP. */
    getPlatformHealth: () =>
      request({
        method: 'GET',
        path: '/platform/v1/health',
        schema: PlatformHealthSchema,
      }),

    /** `metric` é obrigatório e não tem catálogo: quem investiga sabe o nome que procura. */
    getPlatformMetrics: (
      query: { metric: string } & Partial<Omit<PlatformMetricsQuery, 'metric'>>,
    ) =>
      request({
        method: 'GET',
        path: `/platform/v1/metrics${toQueryString(query)}`,
        schema: PlatformMetricSeriesSchema,
      }),

    listPlatformAlerts: (query: Partial<PlatformAlertQuery> = {}) =>
      request({
        method: 'GET',
        path: `/platform/v1/alerts${toQueryString(query)}`,
        schema: PlatformAlertsResponseSchema,
      }),

    /** A leitura registra a si mesma, com o filtro usado: quem vigia também é vigiado. */
    listPlatformAuditLogs: (query: Partial<PlatformAuditQuery> = {}) =>
      request({
        method: 'GET',
        path: `/platform/v1/audit-logs${toQueryString(query)}`,
        schema: PlatformAuditPageSchema,
      }),

    /**
     * Pedir acesso à base de um estabelecimento (MOD-ADMIN-02, AC-01).
     *
     * Só pedir. Quem concede é o administrador do petshop, na aba Suporte das
     * Configurações dele, e é ele quem escolhe o prazo.
     */
    requestSupportAccess: (tenantId: string, reason: string) =>
      request({
        method: 'POST',
        path: `/platform/v1/tenants/${tenantId}/support-access`,
        body: { reason },
        schema: SupportGrantResponseSchema,
      }),

    /**
     * Mudar o plano de um estabelecimento (fatia 2 da camada comercial).
     *
     * Enquanto não há cobrança, é a única forma de subir ou descer de plano. O motivo vai
     * para a trilha que o estabelecimento lê.
     */
    changeTenantPlan: (tenantId: string, input: ChangeTenantPlanInput) =>
      request({
        method: 'PATCH',
        path: `/platform/v1/tenants/${tenantId}/plan`,
        body: input,
        schema: z.object({ tenantId: z.uuid(), plan: PlanSchema }),
      }),
  }
}
