import { z } from 'zod'
import { MAX_MONEY_CENTS } from './money.js'

/**
 * MOD-LEDGER — conta corrente do tutor (PRD financeiro_tutor_05 §5).
 *
 * O módulo substitui a caderneta do balcão: débito entra quando o serviço é
 * concluído, crédito entra quando o pagamento é registrado, e o saldo é a única
 * verdade sobre quanto o tutor deve.
 *
 * Convenção de sinal, válida em toda a plataforma (RN-02): **saldo positivo é crédito
 * do tutor, negativo é dívida**. É a mesma de `tutors.balance_cents`, que já existia
 * esperando por este módulo.
 */

// ─── Vocabulário ─────────────────────────────────────────────────────────────

/** Valor de lançamento: sempre positivo; o sinal vem de `direction`. */
export const MoneyCentsSchema = z.number().int().min(1).max(MAX_MONEY_CENTS)

export const ENTRY_DIRECTIONS = ['DEBIT', 'CREDIT'] as const
export const EntryDirectionSchema = z.enum(ENTRY_DIRECTIONS)
export type EntryDirection = z.infer<typeof EntryDirectionSchema>

export const PAYMENT_METHODS = [
  'CASH',
  'PIX_MANUAL',
  'CARD_MACHINE_DEBIT',
  'CARD_MACHINE_CREDIT',
  'BANK_TRANSFER',
  'PACKAGE_CREDIT',
  'OTHER',
] as const
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS)
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Dinheiro',
  PIX_MANUAL: 'PIX',
  CARD_MACHINE_DEBIT: 'Cartão de débito',
  CARD_MACHINE_CREDIT: 'Cartão de crédito',
  BANK_TRANSFER: 'Transferência',
  PACKAGE_CREDIT: 'Crédito de pacote',
  OTHER: 'Outro',
}

export const ENTRY_CATEGORIES = [
  'SERVICE',
  'PRODUCT',
  'NO_SHOW_FEE',
  'PACKAGE_PURCHASE',
  'PACKAGE_REDEMPTION',
  'PAYMENT',
  'PAYMENT_REVERSAL',
  'ADJUSTMENT',
  'FEE_WAIVER',
  'DISCOUNT',
] as const
export const EntryCategorySchema = z.enum(ENTRY_CATEGORIES)
export type EntryCategory = z.infer<typeof EntryCategorySchema>

export const ENTRY_CATEGORY_LABELS: Record<EntryCategory, string> = {
  SERVICE: 'Serviço',
  PRODUCT: 'Produto',
  NO_SHOW_FEE: 'Taxa de falta',
  PACKAGE_PURCHASE: 'Compra de pacote',
  PACKAGE_REDEMPTION: 'Uso de pacote',
  PAYMENT: 'Pagamento',
  PAYMENT_REVERSAL: 'Estorno de pagamento',
  ADJUSTMENT: 'Ajuste',
  FEE_WAIVER: 'Perdão de taxa',
  DISCOUNT: 'Desconto',
}

/**
 * Categorias que a recepção pode lançar à mão.
 *
 * As demais nascem de um fato do sistema — um atendimento, um pagamento, um estorno —
 * e deixá-las abertas ao balcão permitiria forjar a origem de um lançamento.
 */
export const MANUAL_ENTRY_CATEGORIES = [
  'SERVICE',
  'PRODUCT',
  'ADJUSTMENT',
  'DISCOUNT',
] as const satisfies readonly EntryCategory[]

export type ManualEntryCategory = (typeof MANUAL_ENTRY_CATEGORIES)[number]

export const ENTRY_SOURCE_TYPES = [
  'ATTENDANCE',
  'APPOINTMENT',
  'PAYMENT',
  'PACKAGE',
  'MANUAL',
  'SYSTEM',
  /** MOD-ESTOQUE-05: a venda do balcão. O `source_id` é a venda, e o índice de origem a protege de débito duplo. */
  'PRODUCT_SALE',
] as const
export const EntrySourceTypeSchema = z.enum(ENTRY_SOURCE_TYPES)
export type EntrySourceType = z.infer<typeof EntrySourceTypeSchema>

export const ENTRY_STATUSES = ['POSTED', 'REVERSED'] as const
export const EntryStatusSchema = z.enum(ENTRY_STATUSES)
export type EntryStatus = z.infer<typeof EntryStatusSchema>

export const PAYMENT_STATUSES = ['RECORDED', 'REVERSED'] as const
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES)
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>

export const PURCHASE_STATUSES = [
  'ACTIVE',
  'CONSUMED',
  'EXPIRED',
  'SUSPENDED',
  'CANCELLED',
] as const
export const PurchaseStatusSchema = z.enum(PURCHASE_STATUSES)
export type PurchaseStatus = z.infer<typeof PurchaseStatusSchema>

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  ACTIVE: 'Ativo',
  CONSUMED: 'Todo utilizado',
  EXPIRED: 'Expirado',
  SUSPENDED: 'Suspenso',
  CANCELLED: 'Cancelado',
}

// ─── MOD-LEDGER-02 — lançamento ──────────────────────────────────────────────

export const CreateLedgerEntrySchema = z
  .object({
    tutorId: z.uuid(),
    direction: EntryDirectionSchema,
    amountCents: MoneyCentsSchema,
    category: z.enum(MANUAL_ENTRY_CATEGORIES),
    /** Texto que o tutor lê no extrato — por isso é obrigatório e não pode ser vago. */
    description: z.string().trim().min(3).max(200),
    /** Nunca exposto ao tutor; cifrado em repouso. */
    internalNotes: z.string().trim().max(1000).optional(),
    petId: z.uuid().optional(),
    /** RN-23: o fato pode ser de ontem. O registro nunca é. */
    occurredAt: z.iso.datetime().optional(),
    idempotencyKey: z.uuid(),
  })
  .refine((input) => !input.occurredAt || new Date(input.occurredAt) <= new Date(), {
    message: 'Lançamento não pode ter data futura',
    path: ['occurredAt'],
  })
export type CreateLedgerEntryInput = z.output<typeof CreateLedgerEntrySchema>

export const ReverseSchema = z.object({
  reason: z.string().trim().min(3).max(500),
})
export type ReverseInput = z.output<typeof ReverseSchema>

export const LedgerEntrySchema = z.object({
  id: z.uuid(),
  tutorId: z.uuid(),
  petId: z.uuid().nullable(),
  direction: EntryDirectionSchema,
  amountCents: z.number().int(),
  signedAmountCents: z.number().int(),
  balanceAfterCents: z.number().int(),
  category: EntryCategorySchema,
  description: z.string(),
  /** Ausente para quem só tem `finance:read_own` — a filtragem é no servidor (AC-03). */
  internalNotes: z.string().nullable().optional(),
  sourceType: EntrySourceTypeSchema,
  sourceId: z.uuid().nullable(),
  occurredAt: z.iso.datetime(),
  postedAt: z.iso.datetime(),
  status: EntryStatusSchema,
  /** Quanto do débito já foi quitado. Igual a `amountCents` = liquidado. */
  settledCents: z.number().int(),
  reversedByEntryId: z.uuid().nullable(),
  reversesEntryId: z.uuid().nullable(),
})
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

// ─── MOD-LEDGER-01 — conta ───────────────────────────────────────────────────

export const LedgerAccountSchema = z.object({
  tutorId: z.uuid(),
  balanceCents: z.number().int(),
  currency: z.string(),
  /** Débitos abertos, para o cabeçalho da ficha não precisar somar o extrato. */
  openDebitsCents: z.number().int(),
  openDebitsCount: z.number().int(),
  oldestOpenDebitAt: z.iso.datetime().nullable(),
  lastEntryAt: z.iso.datetime().nullable(),
  lastPaymentAt: z.iso.datetime().nullable(),
  /** RN-18: divergência detectada pelo job. Não bloqueia lançamento novo. */
  needsReview: z.boolean(),
})
export type LedgerAccount = z.infer<typeof LedgerAccountSchema>

// ─── MOD-LEDGER-06 — extrato ─────────────────────────────────────────────────

export const StatementQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type StatementQuery = z.output<typeof StatementQuerySchema>

export const StatementSummarySchema = z.object({
  openingBalanceCents: z.number().int(),
  totalDebitsCents: z.number().int(),
  totalCreditsCents: z.number().int(),
  closingBalanceCents: z.number().int(),
})
export type StatementSummary = z.infer<typeof StatementSummarySchema>

export const StatementSchema = z.object({
  data: z.array(LedgerEntrySchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  summary: StatementSummarySchema,
})
export type Statement = z.infer<typeof StatementSchema>

// ─── MOD-LEDGER-03 — pagamento ───────────────────────────────────────────────

export const AllocationInputSchema = z.object({
  debitEntryId: z.uuid(),
  amountCents: MoneyCentsSchema,
})

export const CreatePaymentSchema = z
  .object({
    tutorId: z.uuid(),
    amountCents: MoneyCentsSchema,
    method: PaymentMethodSchema,
    receivedAt: z.iso.datetime(),
    notes: z.string().trim().max(1000).optional(),
    proofUrl: z.url().optional(),
    /** Vazio = alocação automática FIFO (RN-06). Preenchido exige auditoria. */
    allocations: z.array(AllocationInputSchema).optional(),
    idempotencyKey: z.uuid(),
  })
  .superRefine((input, ctx) => {
    if (input.allocations?.length) {
      const sum = input.allocations.reduce((acc, item) => acc + item.amountCents, 0)
      if (sum > input.amountCents) {
        ctx.addIssue({
          code: 'custom',
          path: ['allocations'],
          message: 'Soma das alocações excede o valor pago',
        })
      }
    }
    if (new Date(input.receivedAt) > new Date()) {
      ctx.addIssue({
        code: 'custom',
        path: ['receivedAt'],
        message: 'Pagamento não pode ter data futura',
      })
    }
  })
export type CreatePaymentInput = z.output<typeof CreatePaymentSchema>

export const PaymentAllocationSchema = z.object({
  debitEntryId: z.uuid(),
  debitDescription: z.string(),
  amountCents: z.number().int(),
  allocatedBy: z.enum(['AUTO_FIFO', 'MANUAL']),
  reversedAt: z.iso.datetime().nullable(),
})

export const PaymentSchema = z.object({
  id: z.uuid(),
  tutorId: z.uuid(),
  amountCents: z.number().int(),
  /** RN-07: o que sobrou da alocação vive como crédito na conta. */
  allocatedCents: z.number().int(),
  method: PaymentMethodSchema,
  receivedAt: z.iso.datetime(),
  receivedBy: z.uuid().nullable(),
  entryId: z.uuid(),
  status: PaymentStatusSchema,
  reversalReason: z.string().nullable(),
  notes: z.string().nullable().optional(),
  proofUrl: z.string().nullable().optional(),
  allocations: z.array(PaymentAllocationSchema),
  createdAt: z.iso.datetime(),
})
export type Payment = z.infer<typeof PaymentSchema>

export const ListPaymentsQuerySchema = z.object({
  tutorId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  method: PaymentMethodSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListPaymentsQuery = z.output<typeof ListPaymentsQuerySchema>

export const PaginatedPaymentsSchema = z.object({
  data: z.array(PaymentSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
})
export type PaginatedPayments = z.infer<typeof PaginatedPaymentsSchema>

// ─── MOD-LEDGER-07 — pacotes ─────────────────────────────────────────────────

/** Decisão de negócio 2: 90 dias, sem reembolso. */
export const DEFAULT_PACKAGE_VALIDITY_DAYS = 90

export const CreateServicePackageSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** RN-10: o crédito cobre estes serviços, nunca por equivalência de valor. */
  serviceIds: z.array(z.uuid()).min(1),
  credits: z.number().int().min(1).max(100),
  priceCents: MoneyCentsSchema,
  validityDays: z.number().int().min(1).max(730).default(DEFAULT_PACKAGE_VALIDITY_DAYS),
  active: z.boolean().default(true),
})
export type CreateServicePackageInput = z.output<typeof CreateServicePackageSchema>

export const UpdateServicePackageSchema = CreateServicePackageSchema.partial()
export type UpdateServicePackageInput = z.output<typeof UpdateServicePackageSchema>

export const ServicePackageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  serviceIds: z.array(z.uuid()),
  serviceNames: z.array(z.string()),
  credits: z.number().int(),
  priceCents: z.number().int(),
  validityDays: z.number().int(),
  active: z.boolean(),
  /** Descontinuar não apaga as compras já feitas. */
  activePurchases: z.number().int(),
})
export type ServicePackage = z.infer<typeof ServicePackageSchema>

export const CreatePackagePurchaseSchema = z.object({
  tutorId: z.uuid(),
  petId: z.uuid().optional(),
  paymentMethod: PaymentMethodSchema,
  /** Desconto na venda; exige `finance:credit`. */
  priceOverrideCents: MoneyCentsSchema.optional(),
  idempotencyKey: z.uuid(),
})
export type CreatePackagePurchaseInput = z.output<typeof CreatePackagePurchaseSchema>

export const UpdatePackagePurchaseSchema = z
  .object({
    /** AC-05: reatribuir a outro pet do mesmo tutor. Reativa o pacote suspenso. */
    petId: z.uuid().nullable().optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((input) => input.status !== 'CANCELLED' || (input.reason?.length ?? 0) >= 3, {
    message: 'Cancelar um pacote exige justificativa',
    path: ['reason'],
  })
export type UpdatePackagePurchaseInput = z.output<typeof UpdatePackagePurchaseSchema>

export const PackagePurchaseSchema = z.object({
  id: z.uuid(),
  packageId: z.uuid(),
  tutorId: z.uuid(),
  petId: z.uuid().nullable(),
  petName: z.string().nullable(),
  name: z.string(),
  serviceIds: z.array(z.uuid()),
  creditsTotal: z.number().int(),
  creditsUsed: z.number().int(),
  creditsRemaining: z.number().int(),
  pricePaidCents: z.number().int(),
  purchasedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  status: PurchaseStatusSchema,
  suspensionReason: z.string().nullable().optional(),
})
export type PackagePurchase = z.infer<typeof PackagePurchaseSchema>

export const RedeemPackageSchema = z.object({
  attendanceId: z.uuid(),
  serviceId: z.uuid(),
  petId: z.uuid(),
})
export type RedeemPackageInput = z.output<typeof RedeemPackageSchema>

// ─── billing_settings ────────────────────────────────────────────────────────

/**
 * Políticas financeiras do tenant.
 *
 * `no_show_fee_percent` e `cancellation_window_hours` **não** moram aqui: já vivem em
 * `tenant_settings` e o scheduling-service já calcula a taxa com eles. Duplicá-los
 * criaria duas fontes de verdade sobre quanto se cobra de quem falta.
 */
export const BillingSettingsSchema = z.object({
  /** Nulo = sem bloqueio. A política é opt-in por tenant (RN-15). */
  creditLimitCents: z.number().int().nullable(),
  overdueDays: z.number().int(),
  enabledPaymentMethods: z.array(PaymentMethodSchema),
  defaultPackageValidityDays: z.number().int(),
  /** Avisos prévios de expiração, em dias. RN-09: expirar sem avisar é falha nossa. */
  packageExpiryWarningDays: z.array(z.number().int()),
  noShowConsumesPackageCredit: z.boolean(),
  receiptFooterText: z.string().nullable(),
  /**
   * A chave PIX que o tutor copia para pagar (AC-05 de MOD-PORTAL-08).
   *
   * Instrução de pagamento, não checkout: a v1 não processa dinheiro (RN-19) e quem
   * registra a entrada continua sendo o balcão. Nula, o Portal mostra só o telefone e
   * o horário de atendimento — nunca um campo vazio dizendo "PIX".
   */
  pixKey: z.string().nullable(),
})
export type BillingSettings = z.infer<typeof BillingSettingsSchema>

export const UpdateBillingSettingsSchema = z.object({
  creditLimitCents: z.number().int().min(0).max(MAX_MONEY_CENTS).nullable().optional(),
  overdueDays: z.number().int().min(1).max(365).optional(),
  enabledPaymentMethods: z.array(PaymentMethodSchema).min(1).optional(),
  defaultPackageValidityDays: z.number().int().min(1).max(730).optional(),
  packageExpiryWarningDays: z.array(z.number().int().min(0).max(365)).max(5).optional(),
  noShowConsumesPackageCredit: z.boolean().optional(),
  receiptFooterText: z.string().trim().max(500).nullable().optional(),
  pixKey: z.string().trim().max(140).nullable().optional(),
})
export type UpdateBillingSettingsInput = z.output<typeof UpdateBillingSettingsSchema>

/**
 * Padrão de instalação. Todas as formas de pagamento habilitadas: o tenant desliga o
 * que não usa, em vez de descobrir no balcão que a maquininha "não é aceita".
 */
export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  creditLimitCents: null,
  overdueDays: 30,
  enabledPaymentMethods: [...PAYMENT_METHODS],
  defaultPackageValidityDays: DEFAULT_PACKAGE_VALIDITY_DAYS,
  packageExpiryWarningDays: [15, 3],
  noShowConsumesPackageCredit: false,
  receiptFooterText: null,
  pixKey: null,
}

// ─── MOD-LEDGER-09 — limite de crédito e inadimplência ───────────────────────

export const CreditCheckQuerySchema = z.object({
  /** Quanto o agendamento vai somar à dívida. Zero consulta só a situação atual. */
  amountCents: z.coerce.number().int().min(0).max(MAX_MONEY_CENTS).default(0),
})
export type CreditCheckQuery = z.output<typeof CreditCheckQuerySchema>

export const CreditCheckResponseSchema = z.object({
  /** Falso só quando há limite configurado e a projeção o ultrapassa. */
  allowed: z.boolean(),
  /** Há débito em aberto? A agenda mostra o aviso mesmo quando `allowed`. */
  warning: z.boolean(),
  requiresOverride: z.boolean(),
  balanceCents: z.number().int(),
  /** Saldo depois do que se pretende agendar. */
  projectedCents: z.number().int(),
  /** Nulo = o tenant não configurou bloqueio (RN-15). */
  limitCents: z.number().int().nullable(),
  overdueDays: z.number().int(),
  message: z.string(),
})
export type CreditCheckResponse = z.infer<typeof CreditCheckResponseSchema>

/** Contrato do §5 para o CRM e o agente de IA. */
export const TUTOR_FINANCIAL_STATUSES = ['CREDIT', 'SETTLED', 'DEBT', 'OVERDUE'] as const
export const TutorFinancialStatusSchema = z.enum(TUTOR_FINANCIAL_STATUSES)
export type TutorFinancialStatus = z.infer<typeof TutorFinancialStatusSchema>

export const ReceiptSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  status: z.enum(['PENDING', 'ISSUED', 'SENT', 'CANCELLED']),
  issuedAt: z.iso.datetime().nullable(),
  /** Nula enquanto o PDF não existir — a tela mostra "em preparo", não link morto. */
  url: z.url().nullable(),
})
export type Receipt = z.infer<typeof ReceiptSchema>

// ─── Relatórios ──────────────────────────────────────────────────────────────

export const CashflowQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
})
export type CashflowQuery = z.output<typeof CashflowQuerySchema>

export const CashflowSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  totalCents: z.number().int(),
  paymentsCount: z.number().int(),
  byMethod: z.array(
    z.object({
      method: PaymentMethodSchema,
      totalCents: z.number().int(),
      count: z.number().int(),
    }),
  ),
})
export type Cashflow = z.infer<typeof CashflowSchema>

export const ReceivablesSchema = z.object({
  buckets: z.object({
    '0_30d': z.number().int(),
    '30_60d': z.number().int(),
    '60d_plus': z.number().int(),
  }),
  totalCents: z.number().int(),
})
export type Receivables = z.infer<typeof ReceivablesSchema>

// ─── Indicadores do financeiro (painel do Início) ────────────────────────────

export const FinanceIndicatorsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
})
export type FinanceIndicatorsQuery = z.output<typeof FinanceIndicatorsQuerySchema>

/**
 * Os números do §10 do PRD financeiro_tutor_05 que os relatórios de cobrança não dão.
 *
 * - `collection.averageDays`: do fato gerador ao pagamento que o quitou, ponderado pelo
 *   valor — um banho de R$ 60 pago em 40 dias não pesa o mesmo que uma tosa de R$ 300
 *   paga na hora. `null` quando nada foi quitado no período.
 * - `packages`: tutores ativos com pacote vigente agora, sobre a carteira ativa.
 * - `expired`: o que venceu no período sem ser usado. É crédito que o tutor perdeu
 *   (RN-08) — alerta de cliente frustrado, e não receita.
 */
export const FinanceIndicatorsSchema = z.object({
  days: z.number().int(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  collection: z.object({
    averageDays: z.number().nullable(),
    settledCents: z.number().int(),
  }),
  packages: z.object({
    tutorsWithActive: z.number().int(),
    activeTutors: z.number().int(),
  }),
  expired: z.object({
    purchases: z.number().int(),
    credits: z.number().int(),
    valueCents: z.number().int(),
  }),
})
export type FinanceIndicators = z.infer<typeof FinanceIndicatorsSchema>

// ─── Cobrança — os dois relatórios imprimíveis ───────────────────────────────

/**
 * Os relatórios do menu Cobrança.
 *
 * Não substituem `ReceivablesSchema`/`CashflowSchema`, que continuam sendo os números
 * do painel: aquilo é um total por faixa, isto é a lista de quem deve e a de quanto
 * entrou em cada dia. O painel responde "como estamos"; o relatório é o papel que
 * alguém leva para o telefone ou para o fechamento do caixa.
 */

export const AGING_BUCKETS = ['0_30d', '30_60d', '60d_plus'] as const
export const AgingBucketSchema = z.enum(AGING_BUCKETS)
export type AgingBucket = z.infer<typeof AgingBucketSchema>

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  '0_30d': 'Até 30 dias',
  '30_60d': '30 a 60 dias',
  '60d_plus': 'Mais de 60 dias',
}

export const AccountsReceivableQuerySchema = z.object({
  /** Data-base do envelhecimento. Sem ela, hoje no fuso do estabelecimento. */
  asOf: z.iso.date().optional(),
  /** Só quem já passou de N dias de atraso. Zero traz tudo em aberto. */
  minOverdueDays: z.coerce.number().int().min(0).max(3650).default(0),
})
export type AccountsReceivableQuery = z.output<typeof AccountsReceivableQuerySchema>

export const AccountsReceivableRowSchema = z.object({
  tutorId: z.uuid(),
  /** Nome social quando houver — RN-14. */
  tutorName: z.string(),
  /** Telefone em E.164, decifrado. É por ele que a cobrança acontece. */
  phone: z.string().nullable(),
  /** `occurred_at` do débito em aberto mais antigo. */
  oldestDueAt: z.iso.datetime(),
  /** Dias entre `oldestDueAt` e a data-base. */
  overdueDays: z.number().int(),
  openEntries: z.number().int(),
  buckets: z.object({
    '0_30d': z.number().int(),
    '30_60d': z.number().int(),
    '60d_plus': z.number().int(),
  }),
  totalCents: z.number().int(),
})
export type AccountsReceivableRow = z.infer<typeof AccountsReceivableRowSchema>

export const AccountsReceivableReportSchema = z.object({
  tenantName: z.string(),
  /** Instante em que o relatório foi montado — sai impresso no rodapé. */
  generatedAt: z.iso.datetime(),
  /** O fuso do estabelecimento: é nele que o papel imprime datas e horas. */
  timezone: z.string(),
  asOf: z.iso.date(),
  minOverdueDays: z.number().int(),
  buckets: z.object({
    '0_30d': z.number().int(),
    '30_60d': z.number().int(),
    '60d_plus': z.number().int(),
  }),
  totalCents: z.number().int(),
  tutorsCount: z.number().int(),
  /**
   * Verdadeiro quando a lista foi cortada em `ACCOUNTS_RECEIVABLE_MAX_ROWS`. O papel
   * diz isso em letras, para ninguém fechar o mês achando que viu tudo.
   */
  truncated: z.boolean(),
  rows: z.array(AccountsReceivableRowSchema),
})
export type AccountsReceivableReport = z.infer<typeof AccountsReceivableReportSchema>

/** Teto da listagem. Acima disso o papel deixa de ser lista e vira resma. */
export const ACCOUNTS_RECEIVABLE_MAX_ROWS = 500

export const ReceiptsByDayQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
})
export type ReceiptsByDayQuery = z.output<typeof ReceiptsByDayQuerySchema>

const MethodTotalSchema = z.object({
  method: PaymentMethodSchema,
  totalCents: z.number().int(),
  count: z.number().int(),
})

export const ReceiptsByDayRowSchema = z.object({
  /** O dia **no fuso do estabelecimento**, não em UTC. */
  date: z.iso.date(),
  totalCents: z.number().int(),
  count: z.number().int(),
  byMethod: z.array(MethodTotalSchema),
})
export type ReceiptsByDayRow = z.infer<typeof ReceiptsByDayRowSchema>

export const ReceiptsByDayReportSchema = z.object({
  tenantName: z.string(),
  generatedAt: z.iso.datetime(),
  timezone: z.string(),
  from: z.iso.date(),
  to: z.iso.date(),
  totalCents: z.number().int(),
  paymentsCount: z.number().int(),
  /** Total do período por forma de pagamento — o fechamento do caixa. */
  byMethod: z.array(MethodTotalSchema),
  /** Um item por dia **com movimento**; dia sem entrada não vira linha vazia. */
  days: z.array(ReceiptsByDayRowSchema),
})
export type ReceiptsByDayReport = z.infer<typeof ReceiptsByDayReportSchema>

/** Janela máxima do relatório diário. Um ano de linhas ainda cabe num PDF. */
export const RECEIPTS_BY_DAY_MAX_DAYS = 366
