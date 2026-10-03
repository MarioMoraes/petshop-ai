import {
  AuditLogPageSchema,
  SecurityEventPageSchema,
  SecurityEventSummaryResponseSchema,
  SupportGrantResponseSchema,
  SupportGrantsResponseSchema,
  type AuditLogQuery,
  type SecurityEventQuery,
} from '@petshop/shared-types'
import { type Transport, toQueryString } from '../transport.js'

export function securityEndpoints({ request }: Transport) {
  return {
    // ─── Segurança e compliance (MOD-SEC-04 e 05) ──────────────────────────

    /**
     * A trilha de auditoria do estabelecimento.
     *
     * Paginada por cursor, e sem total: contar dois anos de trilha a cada abertura de
     * tela é uma varredura por curiosidade. A janela máxima é de 92 dias por consulta.
     */
    listAuditLogs: (query: Partial<AuditLogQuery> = {}) =>
      request({
        method: 'GET',
        path: `/v1/audit-logs${toQueryString(query)}`,
        schema: AuditLogPageSchema,
      }),

    listSecurityEvents: (query: Partial<Omit<SecurityEventQuery, 'summary'>> = {}) =>
      request({
        method: 'GET',
        path: `/v1/security-events${toQueryString(query)}`,
        schema: SecurityEventPageSchema,
      }),

    /**
     * A contagem por tipo no período.
     *
     * É o que a tela mostra antes de alguém pedir o detalhe: uma linha isolada de
     * `PERMISSION_DENIED` não diz nada, e trinta num dia dizem que alguém está tentando
     * chegar onde não deve.
     */
    summarizeSecurityEvents: (query: Partial<Omit<SecurityEventQuery, 'summary'>> = {}) =>
      request({
        method: 'GET',
        path: `/v1/security-events${toQueryString({ ...query, summary: true })}`,
        schema: SecurityEventSummaryResponseSchema,
      }),

    // ─── Acesso do suporte (MOD-ADMIN-02, o lado do estabelecimento) ───────

    /**
     * Os pedidos e acessos de suporte **deste** estabelecimento.
     *
     * A leitura é mais larga que a escrita de propósito (`tenant:read_settings`): quem
     * opera o balcão não aprova acesso, mas precisa ver que alguém de fora está lendo a
     * base. Esconder o histórico de quem trabalha ali faria do consentimento uma
     * formalidade.
     */
    listSupportAccess: () =>
      request({
        method: 'GET',
        path: '/v1/support-access',
        schema: SupportGrantsResponseSchema,
      }),

    /** Aprova, com o prazo em horas. O teto é do servidor, e o tenant só encurta. */
    approveSupportAccess: (id: string, hours: number) =>
      request({
        method: 'POST',
        path: `/v1/support-access/${id}/approve`,
        body: { hours },
        schema: SupportGrantResponseSchema,
      }),

    denySupportAccess: (id: string) =>
      request<void>({ method: 'POST', path: `/v1/support-access/${id}/deny` }),

    /** Vale no clique: a checagem do grant lê o banco a cada requisição, sem cache. */
    revokeSupportAccess: (id: string) =>
      request<void>({ method: 'POST', path: `/v1/support-access/${id}/revoke` }),
  }
}
