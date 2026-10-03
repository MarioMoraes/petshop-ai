import {
  CashAlertsSchema,
  CashReportSchema,
  CashSessionDetailSchema,
  CashSessionPageSchema,
  CurrentCashSessionSchema,
  type CashAdjustmentInput,
  type CloseCashSessionInput,
  type PositionReportQuery,
} from '@petshop/shared-types'
import { type Transport, toQueryString } from '../transport.js'

export function cashEndpoints({ request, download }: Transport) {
  return {
    // ─── MOD-CAIXA — o caixa do dia ──────────────────────────────────────────

    /** O caixa aberto agora, com os movimentos — `{ session: null }` quando não há. */
    getCurrentCash: () =>
      request({ method: 'GET', path: '/v1/cash/current', schema: CurrentCashSessionSchema }),

    /** Só o caixa esquecido aberto, para o sino: leve de propósito, roda em toda navegação. */
    getCashAlerts: () =>
      request({ method: 'GET', path: '/v1/cash/alerts', schema: CashAlertsSchema }),

    /** O fechamento impresso — ou a conferência parcial do caixa ainda aberto. */
    downloadCashSessionPdf: (id: string) =>
      download(`/v1/cash/sessions/${id}/pdf`, 'fechamento-do-caixa.pdf'),

    listCashSessions: (query: { cursor?: string; limit?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/cash/sessions${toQueryString(query)}`,
        schema: CashSessionPageSchema,
      }),

    /** Os relatórios do caixa. Sem `from`/`to`, o mês corrente até hoje. */
    getCashReport: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/cash/reports${toQueryString(query)}`,
        schema: CashReportSchema,
      }),

    getCashSession: (id: string) =>
      request({ method: 'GET', path: `/v1/cash/sessions/${id}`, schema: CashSessionDetailSchema }),

    openCash: (openingFloatCents: number) =>
      request({
        method: 'POST',
        path: '/v1/cash/sessions',
        body: { openingFloatCents },
        schema: CashSessionDetailSchema,
      }),

    adjustCash: (input: CashAdjustmentInput) =>
      request({
        method: 'POST',
        path: '/v1/cash/adjustments',
        body: input,
        schema: CashSessionDetailSchema,
      }),

    closeCash: (id: string, input: CloseCashSessionInput) =>
      request({
        method: 'POST',
        path: `/v1/cash/sessions/${id}/close`,
        body: input,
        schema: CashSessionDetailSchema,
      }),

    /** Bytes, como os relatórios do financeiro: o retrato de um instante não se arquiva. */
    downloadInventoryPositionPdf: (query: Partial<PositionReportQuery> = {}) =>
      download(
        `/v1/inventory/reports/position/pdf${toQueryString(query)}`,
        'posicao-do-estoque.pdf',
      ),
  }
}
