import { z } from 'zod'
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from './ledger.js'
import { MAX_MONEY_CENTS } from './money.js'

/**
 * MOD-CAIXA — o caixa do dia (PRD caixa_17).
 *
 * A gaveta do balcão: abre com troco, recebe a venda avulsa e o pagamento dos tutores,
 * perde a sangria, ganha o suprimento e fecha com a contagem. Backend, cliente de API e
 * tela dividem este arquivo.
 */

// ─── Formas de pagamento do balcão ───────────────────────────────────────────

/**
 * As formas que passam pelo caixa. **Crédito de pacote fica de fora**: é consumo de um
 * pagamento já feito, e não dinheiro entrando agora.
 */
export const CASH_METHODS = [
  'CASH',
  'PIX_MANUAL',
  'CARD_MACHINE_DEBIT',
  'CARD_MACHINE_CREDIT',
  'BANK_TRANSFER',
  'OTHER',
] as const satisfies readonly PaymentMethod[]
export const CashMethodSchema = z.enum(CASH_METHODS)
export type CashMethod = z.output<typeof CashMethodSchema>

export const CASH_METHOD_LABELS: Record<CashMethod, string> = {
  CASH: PAYMENT_METHOD_LABELS.CASH,
  PIX_MANUAL: PAYMENT_METHOD_LABELS.PIX_MANUAL,
  CARD_MACHINE_DEBIT: PAYMENT_METHOD_LABELS.CARD_MACHINE_DEBIT,
  CARD_MACHINE_CREDIT: PAYMENT_METHOD_LABELS.CARD_MACHINE_CREDIT,
  BANK_TRANSFER: PAYMENT_METHOD_LABELS.BANK_TRANSFER,
  OTHER: PAYMENT_METHOD_LABELS.OTHER,
}

export function isCashMethod(method: string): method is CashMethod {
  return (CASH_METHODS as readonly string[]).includes(method)
}

// ─── Movimentos ──────────────────────────────────────────────────────────────

export const CASH_MOVEMENT_TYPES = [
  'OPENING_FLOAT',
  'WALK_IN_SALE',
  'SALE_REFUND',
  'TUTOR_PAYMENT',
  'PAYMENT_REVERSAL',
  'WITHDRAWAL',
  'DEPOSIT',
] as const
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number]

export const CASH_MOVEMENT_LABELS: Record<CashMovementType, string> = {
  OPENING_FLOAT: 'Troco inicial',
  WALK_IN_SALE: 'Venda avulsa',
  SALE_REFUND: 'Estorno de venda',
  TUTOR_PAYMENT: 'Pagamento de tutor',
  PAYMENT_REVERSAL: 'Estorno de pagamento',
  WITHDRAWAL: 'Sangria',
  DEPOSIT: 'Suprimento',
}

export const CASH_SESSION_STATUSES = ['OPEN', 'CLOSED'] as const
export type CashSessionStatus = (typeof CASH_SESSION_STATUSES)[number]

const CentsSchema = z
  .number({ message: 'Informe o valor' })
  .int('Valor em centavos')
  .max(MAX_MONEY_CENTS, 'Valor alto demais')

// ─── Entradas ────────────────────────────────────────────────────────────────

export const OpenCashSessionSchema = z.object({
  /** O troco que está na gaveta ao abrir. Zero é abrir com a gaveta vazia. */
  openingFloatCents: CentsSchema.min(0, 'O troco não pode ser negativo').default(0),
})
export type OpenCashSessionInput = z.output<typeof OpenCashSessionSchema>

/**
 * Sangria e suprimento. Sempre em dinheiro: é o que se tira da gaveta para o cofre, ou
 * se põe nela para ter troco. PIX não entra nem sai de gaveta.
 */
export const CashAdjustmentSchema = z.object({
  type: z.enum(['WITHDRAWAL', 'DEPOSIT']),
  amountCents: CentsSchema.min(1, 'Informe um valor maior que zero'),
  reason: z.string().trim().min(3, 'Diga o motivo').max(200),
})
export type CashAdjustmentInput = z.output<typeof CashAdjustmentSchema>

export const CloseCashSessionSchema = z.object({
  /**
   * O contado, por forma. O dinheiro é obrigatório; as outras formas são opcionais —
   * quem não confere a maquininha na hora deixa em branco e fica valendo o esperado.
   */
  counts: z
    .array(
      z.object({
        method: CashMethodSchema,
        countedCents: CentsSchema.min(0, 'O contado não pode ser negativo'),
      }),
    )
    .max(CASH_METHODS.length),
  /** Obrigatória quando o contado não bate com o esperado — conferido no serviço. */
  notes: z.string().trim().max(500).optional(),
})
export type CloseCashSessionInput = z.output<typeof CloseCashSessionSchema>

export const CashSessionListQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type CashSessionListQuery = z.output<typeof CashSessionListQuerySchema>

// ─── Respostas ───────────────────────────────────────────────────────────────

export const CashMethodTotalSchema = z.object({
  method: CashMethodSchema,
  /** A soma dos movimentos desta forma — o que deveria haver. */
  expectedCents: z.number().int(),
  /** Nulo enquanto o caixa está aberto, ou quando a forma não foi conferida. */
  countedCents: z.number().int().nullable(),
})
export type CashMethodTotal = z.output<typeof CashMethodTotalSchema>

export const CashMovementResponseSchema = z.object({
  id: z.uuid(),
  type: z.enum(CASH_MOVEMENT_TYPES),
  method: CashMethodSchema,
  amountCents: z.number().int(),
  /** O que a linha diz: "Venda avulsa · 2 itens", "Pagamento · Maria Silva", o motivo da sangria. */
  description: z.string(),
  createdByName: z.string().nullable(),
  occurredAt: z.string(),
})
export type CashMovementResponse = z.output<typeof CashMovementResponseSchema>

export const CashSessionSummarySchema = z.object({
  id: z.uuid(),
  status: z.enum(CASH_SESSION_STATUSES),
  openedAt: z.string(),
  openedByName: z.string().nullable(),
  openingFloatCents: z.number().int(),
  closedAt: z.string().nullable(),
  closedByName: z.string().nullable(),
  /** Uma linha por forma que teve movimento, com o dinheiro sempre presente. */
  byMethod: z.array(CashMethodTotalSchema),
  /** O que entrou menos o que saiu, fora o troco e as sangrias: a venda do dia. */
  receivedCents: z.number().int(),
  /** Contado menos esperado. Nulo enquanto aberto. Negativo é falta. */
  differenceCents: z.number().int().nullable(),
  closingNotes: z.string().nullable(),
})
export type CashSessionSummary = z.output<typeof CashSessionSummarySchema>

export const CashSessionDetailSchema = CashSessionSummarySchema.extend({
  movements: z.array(CashMovementResponseSchema),
})
export type CashSessionDetail = z.output<typeof CashSessionDetailSchema>

export const CurrentCashSessionSchema = z.object({
  session: CashSessionDetailSchema.nullable(),
})
export type CurrentCashSession = z.output<typeof CurrentCashSessionSchema>

export const CashSessionPageSchema = z.object({
  items: z.array(CashSessionSummarySchema),
  nextCursor: z.uuid().nullable(),
})
export type CashSessionPage = z.output<typeof CashSessionPageSchema>

/**
 * O que o sino pergunta ao caixa: se há um aberto desde um dia que já passou.
 *
 * `openedOn` é o dia da abertura **no fuso do estabelecimento**, e é o servidor quem o
 * calcula: o caixa aberto às 22h de ontem em São Paulo já é "hoje" em UTC, e a moldura
 * não deveria precisar saber disso para acender a linha.
 */
export const CashAlertsSchema = z.object({
  staleSession: z
    .object({
      id: z.uuid(),
      openedAt: z.string(),
      openedOn: z.iso.date(),
    })
    .nullable(),
})
export type CashAlerts = z.output<typeof CashAlertsSchema>
