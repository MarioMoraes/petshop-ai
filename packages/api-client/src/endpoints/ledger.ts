import {
  LedgerAccountSchema,
  LedgerEntrySchema,
  PackagePurchaseSchema,
  PaginatedPaymentsSchema,
  PaymentSchema,
  ReceiptSchema,
  ReceivablesSchema,
  FinanceIndicatorsSchema,
  AccountsReceivableReportSchema,
  ReceiptsByDayReportSchema,
  CashflowSchema,
  CreditCheckResponseSchema,
  ServicePackageSchema,
  StatementSchema,
  OnlineBillingSchema,
  TutorChargeSchema,
  TutorChargeCreatedSchema,
  type AsaasEnvironment,
  type CreateLedgerEntryInput,
  type CreatePackagePurchaseInput,
  type CreatePaymentInput,
  type CreateServicePackageInput,
  type UpdatePackagePurchaseInput,
  type UpdateServicePackageInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function ledgerEndpoints({ request, download }: Transport) {
  return {
    // ─── MOD-LEDGER — conta corrente do tutor ──────────────────────────────

    getLedgerAccount: (tutorId: string) =>
      request({
        method: 'GET',
        path: `/v1/ledger/accounts/${tutorId}`,
        schema: LedgerAccountSchema,
      }),

    getStatement: (
      tutorId: string,
      query: { from?: string; to?: string; page?: number; limit?: number } = {},
    ) =>
      request({
        method: 'GET',
        path: `/v1/ledger/accounts/${tutorId}/statement${toQueryString(query)}`,
        schema: StatementSchema,
      }),

    createLedgerEntry: (input: CreateLedgerEntryInput) =>
      request({
        method: 'POST',
        path: '/v1/ledger/entries',
        body: input,
        schema: LedgerEntrySchema,
      }),

    reverseLedgerEntry: (id: string, input: { reason: string }) =>
      request({
        method: 'POST',
        path: `/v1/ledger/entries/${id}/reverse`,
        body: input,
        schema: z.object({ entryId: z.uuid(), reversalEntryId: z.uuid() }),
      }),

    createPayment: (input: CreatePaymentInput) =>
      request({
        method: 'POST',
        path: '/v1/payments',
        body: input,
        schema: PaymentSchema,
      }),

    listPayments: (
      query: {
        tutorId?: string
        from?: string
        to?: string
        method?: string
        page?: number
        limit?: number
      } = {},
    ) =>
      request({
        method: 'GET',
        path: `/v1/payments${toQueryString(query)}`,
        schema: PaginatedPaymentsSchema,
      }),

    reversePayment: (id: string, input: { reason: string }) =>
      request({
        method: 'POST',
        path: `/v1/payments/${id}/reverse`,
        body: input,
        schema: z.object({ paymentId: z.uuid(), reversalEntryId: z.uuid() }),
      }),

    listServicePackages: (query: { includeInactive?: boolean } = {}) =>
      request({
        method: 'GET',
        path: `/v1/packages${toQueryString(query)}`,
        schema: z.object({ data: z.array(ServicePackageSchema) }),
      }),

    createServicePackage: (input: CreateServicePackageInput) =>
      request({
        method: 'POST',
        path: '/v1/packages',
        body: input,
        schema: z.object({ id: z.uuid() }),
      }),

    updateServicePackage: (id: string, input: UpdateServicePackageInput) =>
      request({
        method: 'PATCH',
        path: `/v1/packages/${id}`,
        body: input,
        schema: z.object({ id: z.uuid() }),
      }),

    purchasePackage: (packageId: string, input: CreatePackagePurchaseInput) =>
      request({
        method: 'POST',
        path: `/v1/packages/${packageId}/purchases`,
        body: input,
        schema: PackagePurchaseSchema,
      }),

    listTutorPackages: (tutorId: string) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${tutorId}/packages`,
        schema: z.object({ data: z.array(PackagePurchaseSchema) }),
      }),

    updatePackagePurchase: (id: string, input: UpdatePackagePurchaseInput) =>
      request({
        method: 'PATCH',
        path: `/v1/packages/purchases/${id}`,
        body: input,
        schema: PackagePurchaseSchema,
      }),

    // ─── Cobrança online do tutor (Asaas do estabelecimento) ─────────────────

    getOnlineBilling: () =>
      request({
        method: 'GET',
        path: '/v1/billing-settings/asaas',
        schema: z.object({ connection: OnlineBillingSchema }),
      }),

    /** Confere a chave no Asaas, cadastra a baixa automática e grava. */
    connectOnlineBilling: (body: { apiKey: string; environment: AsaasEnvironment }) =>
      request({
        method: 'PUT',
        path: '/v1/billing-settings/asaas',
        body,
        schema: z.object({ connection: OnlineBillingSchema }),
      }),

    disconnectOnlineBilling: () =>
      request({
        method: 'DELETE',
        path: '/v1/billing-settings/asaas',
        schema: z.object({ connection: OnlineBillingSchema }),
      }),

    listTutorCharges: (tutorId: string) =>
      request({
        method: 'GET',
        path: `/v1/ledger/accounts/${tutorId}/charges`,
        schema: z.object({ data: z.array(TutorChargeSchema) }),
      }),

    /** Sem valor, cobra o saldo devedor. `send` manda o link ao tutor. */
    createTutorCharge: (tutorId: string, body: { amountCents?: number; send?: boolean }) =>
      request({
        method: 'POST',
        path: `/v1/ledger/accounts/${tutorId}/charges`,
        body,
        schema: TutorChargeCreatedSchema,
      }),

    /** MOD-LEDGER-08 — número, status e URL assinada. Nunca o PDF em stream. */
    getReceipt: (paymentId: string) =>
      request({
        method: 'GET',
        path: `/v1/payments/${paymentId}/receipt`,
        schema: ReceiptSchema,
      }),

    /** MOD-LEDGER-09 — o que a agenda pergunta antes de marcar. Sempre 200. */
    creditCheck: (tutorId: string, amountCents = 0) =>
      request({
        method: 'GET',
        path: `/v1/ledger/accounts/${tutorId}/credit-check?amountCents=${amountCents}`,
        schema: CreditCheckResponseSchema,
      }),

    getReceivables: () =>
      request({
        method: 'GET',
        path: '/v1/ledger/reports/receivables',
        schema: ReceivablesSchema,
      }),

    /** Prazo médio de recebimento, adesão a pacotes e crédito vencido sem uso. */
    getFinanceIndicators: (query: { days?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/reports/indicators${toQueryString(query)}`,
        schema: FinanceIndicatorsSchema,
      }),

    /** Sem `from`/`to`, o dia de hoje no fuso do estabelecimento. */
    getCashflow: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/reports/cashflow${toQueryString(query)}`,
        schema: CashflowSchema,
      }),

    // ─── Cobrança — os relatórios imprimíveis ─────────────────────────────

    /**
     * Contas a receber: quem deve, há quanto tempo e por qual faixa.
     *
     * Difere de `getReceivables`, que continua sendo o total por faixa do painel. Este
     * traz a lista — é o papel de quem vai ligar.
     */
    getAccountsReceivableReport: (query: { asOf?: string; minOverdueDays?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/reports/accounts-receivable${toQueryString(query)}`,
        schema: AccountsReceivableReportSchema,
      }),

    /** Sem `from`/`to`, o mês corrente até hoje no fuso do estabelecimento. */
    getReceiptsByDayReport: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/reports/receipts-by-day${toQueryString(query)}`,
        schema: ReceiptsByDayReportSchema,
      }),

    /**
     * O extrato da conta de um tutor, em papel (MOD-DOC-09).
     *
     * Bytes, e não URL assinada como o recibo: o extrato não é arquivado, porque
     * descreve o presente — um arquivo guardado hoje contradiz o sistema amanhã.
     */
    downloadStatementPdf: (tutorId: string, query: { from?: string; to?: string } = {}) =>
      download(
        `/v1/ledger/accounts/${tutorId}/statement/pdf${toQueryString(query)}`,
        'extrato.pdf',
      ),

    downloadAccountsReceivablePdf: (query: { asOf?: string; minOverdueDays?: number } = {}) =>
      download(
        `/v1/ledger/reports/accounts-receivable/pdf${toQueryString(query)}`,
        'contas-a-receber.pdf',
      ),

    downloadReceiptsByDayPdf: (query: { from?: string; to?: string } = {}) =>
      download(
        `/v1/ledger/reports/receipts-by-day/pdf${toQueryString(query)}`,
        'contas-recebidas.pdf',
      ),
  }
}
