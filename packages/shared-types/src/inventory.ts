import { z } from 'zod'
import { MAX_MONEY_CENTS } from './money.js'

/**
 * MOD-ESTOQUE — o contrato do controle de estoque (PRD estoque_16 §5).
 *
 * Backend, cliente de API e tela dividem este arquivo: os enums, a forma de uma
 * quantidade e as respostas.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

export const PRODUCT_KINDS = ['RETAIL', 'SUPPLY', 'BOTH'] as const
export const ProductKindSchema = z.enum(PRODUCT_KINDS)
export type ProductKind = z.output<typeof ProductKindSchema>

export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  RETAIL: 'Venda',
  SUPPLY: 'Insumo',
  BOTH: 'Venda e insumo',
}

export const PRODUCT_UNITS = ['UN', 'ML', 'L', 'G', 'KG'] as const
export const ProductUnitSchema = z.enum(PRODUCT_UNITS)
export type ProductUnit = z.output<typeof ProductUnitSchema>

export const PRODUCT_UNIT_LABELS: Record<ProductUnit, string> = {
  UN: 'unidade',
  ML: 'ml',
  L: 'litro',
  G: 'g',
  KG: 'kg',
}

export const STOCK_MOVEMENT_TYPES = [
  'PURCHASE_IN',
  'SALE_OUT',
  'CONSUMPTION_OUT',
  'ADJUSTMENT',
  'LOSS',
  'RETURN_IN',
  'VOID_RETURN',
] as const
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number]

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  PURCHASE_IN: 'Entrada',
  SALE_OUT: 'Venda',
  CONSUMPTION_OUT: 'Consumo',
  ADJUSTMENT: 'Ajuste',
  LOSS: 'Perda',
  RETURN_IN: 'Devolução',
  VOID_RETURN: 'Atendimento anulado',
}

/** O lote implícito do produto que não tem código de lote (AC-04 de MOD-ESTOQUE-03). */
export const NO_BATCH_CODE = 'SEM-LOTE'

/**
 * A janela do alerta de validade (MOD-ESTOQUE-09). Fixa na fatia 1; a fatia 4 a leva
 * para a configuração do estabelecimento.
 */
export const INVENTORY_EXPIRY_WARNING_DAYS = 30

// ─── Quantidade ──────────────────────────────────────────────────────────────

/**
 * Quantidade é **string decimal** no fio, com até 3 casas.
 *
 * O banco guarda `Decimal(12,3)` porque insumo se mede em ml e g. Um `number` no JSON
 * faria `0.1 + 0.2` virar saldo. A vírgula é aceita porque é o que o balcão digita.
 */
const QUANTITY_PATTERN = /^-?\d{1,9}(\.\d{1,3})?$/

const quantityText = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim().replace(',', '.'))
  .refine((value) => QUANTITY_PATTERN.test(value), {
    message: 'Informe uma quantidade com até 3 casas decimais',
  })

/** Maior que zero: a quantidade de uma entrada. */
export const PositiveQuantitySchema = quantityText.refine((value) => Number(value) > 0, {
  message: 'A quantidade precisa ser maior que zero',
})

/** Zero ou mais: o ponto de reposição, o saldo contado. */
export const NonNegativeQuantitySchema = quantityText.refine((value) => Number(value) >= 0, {
  message: 'A quantidade não pode ser negativa',
})

/** Com sinal e diferente de zero: a diferença de um ajuste. */
export const SignedQuantitySchema = quantityText.refine((value) => Number(value) !== 0, {
  message: 'A diferença não pode ser zero',
})

const MoneyCentsSchema = z.number().int().min(0).max(MAX_MONEY_CENTS)

/** Data sem hora: a validade impressa na caixa é um dia. */
const DateOnlySchema = z.iso.date({ message: 'Informe a data no formato AAAA-MM-DD' })

/**
 * A chave que a tela gera ao abrir o formulário. O duplo clique repete a chave e não
 * grava duas vezes.
 */
const IdempotencyKeySchema = z.string().trim().min(8).max(80)

// ─── Produto (MOD-ESTOQUE-01) ────────────────────────────────────────────────

const optionalCode = z
  .string()
  .trim()
  .max(40)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional()

/** AC-02: produto de venda tem preço; insumo não precisa. */
function sellable(kind: ProductKind): boolean {
  return kind === 'RETAIL' || kind === 'BOTH'
}

export const CreateProductSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome do produto').max(120),
    sku: optionalCode,
    barcode: optionalCode,
    kind: ProductKindSchema,
    unit: ProductUnitSchema.default('UN'),
    salePriceCents: MoneyCentsSchema.nullable().optional(),
    costCents: MoneyCentsSchema.nullable().optional(),
    minQuantity: NonNegativeQuantitySchema.default('0'),
    tracksExpiry: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (
      sellable(input.kind) &&
      (input.salePriceCents === null || input.salePriceCents === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['salePriceCents'],
        message: 'Produto de venda precisa de preço',
      })
    }
  })
export type CreateProductInput = z.output<typeof CreateProductSchema>

/**
 * O `PATCH` é um schema **à parte**, e não `CreateProductSchema.partial()`: o `.partial()`
 * mantém os `.default()`, e um PATCH só com o nome gravaria `unit: 'UN'` e
 * `tracksExpiry: false` por cima do cadastro. A regra do preço, que depende do tipo
 * gravado, é conferida no serviço.
 */
export const UpdateProductSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do produto').max(120).optional(),
  sku: optionalCode,
  barcode: optionalCode,
  kind: ProductKindSchema.optional(),
  unit: ProductUnitSchema.optional(),
  salePriceCents: MoneyCentsSchema.nullable().optional(),
  costCents: MoneyCentsSchema.nullable().optional(),
  minQuantity: NonNegativeQuantitySchema.optional(),
  tracksExpiry: z.boolean().optional(),
  /** AC-03: desativar tira dos seletores e preserva o histórico. */
  active: z.boolean().optional(),
})
export type UpdateProductInput = z.output<typeof UpdateProductSchema>

export const INVENTORY_ALERT_FILTERS = ['LOW', 'EXPIRING', 'NEGATIVE'] as const

export const ProductListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  kind: ProductKindSchema.optional(),
  /** `LOW`: abaixo do mínimo. `EXPIRING`: lote vencendo ou vencido. `NEGATIVE`: saldo negativo. */
  alert: z.enum(INVENTORY_ALERT_FILTERS).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})
export type ProductListQuery = z.output<typeof ProductListQuerySchema>

// ─── Entrada e ajuste (MOD-ESTOQUE-03/04) ─────────────────────────────────────

export const StockEntrySchema = z.object({
  productId: z.uuid(),
  /** Vazio vira o lote implícito `SEM-LOTE`. */
  batchCode: z
    .string()
    .trim()
    .toUpperCase()
    .max(40)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  expiresAt: DateOnlySchema.nullable().optional(),
  quantity: PositiveQuantitySchema,
  unitCostCents: MoneyCentsSchema.nullable().optional(),
  /** A data da nota — pode ser retroativa. Ausente é agora. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  idempotencyKey: IdempotencyKeySchema,
})
export type StockEntryInput = z.output<typeof StockEntrySchema>

/**
 * AC-02 de MOD-ESTOQUE-04: quem conta a prateleira informa **quantos tem** (`COUNT`), e
 * o sistema calcula a diferença. `DELTA` fica para a correção pontual ("quebrou um
 * frasco").
 */
export const StockAdjustmentSchema = z
  .object({
    lotId: z.uuid(),
    type: z.enum(['ADJUSTMENT', 'LOSS']).default('ADJUSTMENT'),
    mode: z.enum(['COUNT', 'DELTA']),
    quantity: quantityText,
    reason: z.string().trim().min(3, 'Diga o motivo do ajuste').max(200),
    idempotencyKey: IdempotencyKeySchema,
  })
  .superRefine((input, ctx) => {
    const value = Number(input.quantity)
    if (input.mode === 'COUNT' && value < 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'O saldo contado não pode ser negativo',
      })
    }
    if (input.mode === 'DELTA' && value === 0) {
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'A diferença não pode ser zero' })
    }
    // Perda só tira: uma "perda" positiva seria uma entrada sem nota.
    if (input.type === 'LOSS' && input.mode === 'DELTA' && value > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'Perda é uma saída — informe a quantidade negativa',
      })
    }
  })
export type StockAdjustmentInput = z.output<typeof StockAdjustmentSchema>

export const MovementListQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})
export type MovementListQuery = z.output<typeof MovementListQuerySchema>

// ─── Respostas ───────────────────────────────────────────────────────────────
//
// Schemas, e não só tipos: o cliente de API valida a resposta com o mesmo contrato que
// o backend declara.

export const ProductResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  kind: ProductKindSchema,
  unit: ProductUnitSchema,
  salePriceCents: z.number().nullable(),
  costCents: z.number().nullable(),
  minQuantity: z.string(),
  tracksExpiry: z.boolean(),
  active: z.boolean(),
  /** A soma dos lotes (RN-03). Pode ser negativa (RN-06). */
  quantityOnHand: z.string(),
  /** A menor validade entre os lotes com saldo. */
  nextExpiresAt: z.string().nullable(),
  belowMinimum: z.boolean(),
  /** Lotes com saldo que vencem dentro da janela, ou já venceram. */
  expiringLots: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ProductResponse = z.output<typeof ProductResponseSchema>

export const StockLotResponseSchema = z.object({
  id: z.uuid(),
  batchCode: z.string(),
  expiresAt: z.string().nullable(),
  quantityOnHand: z.string(),
  unitCostCents: z.number().nullable(),
  expired: z.boolean(),
  expiring: z.boolean(),
})
export type StockLotResponse = z.output<typeof StockLotResponseSchema>

export const ProductDetailResponseSchema = ProductResponseSchema.extend({
  /** Os lotes com saldo, e os zerados dos últimos 90 dias — o resto é arquivo. */
  lots: z.array(StockLotResponseSchema),
  /** Nunca teve movimento: o único caso em que a exclusão é permitida (AC-03). */
  deletable: z.boolean(),
})
export type ProductDetailResponse = z.output<typeof ProductDetailResponseSchema>

export const StockMovementResponseSchema = z.object({
  id: z.uuid(),
  lotId: z.uuid(),
  batchCode: z.string(),
  type: z.enum(STOCK_MOVEMENT_TYPES),
  quantity: z.string(),
  quantityAfter: z.string(),
  reason: z.string().nullable(),
  createdByName: z.string().nullable(),
  occurredAt: z.string(),
  postedAt: z.string(),
})
export type StockMovementResponse = z.output<typeof StockMovementResponseSchema>

export const StockMovementPageSchema = z.object({
  items: z.array(StockMovementResponseSchema),
  nextCursor: z.uuid().nullable(),
})
export type StockMovementPage = z.output<typeof StockMovementPageSchema>

/** O que a entrada e o ajuste devolvem: o movimento e o lote como ficou. */
export const StockMovementResultSchema = z.object({
  movement: StockMovementResponseSchema,
  lot: StockLotResponseSchema,
  /** A mesma chave já tinha gravado: nada novo aconteceu. */
  repeated: z.boolean(),
})
export type StockMovementResult = z.output<typeof StockMovementResultSchema>

// ─── Venda no balcão (MOD-ESTOQUE-05/06) ─────────────────────────────────────

export const SALE_STATUSES = ['COMPLETED', 'REVERSED'] as const
export const SaleStatusSchema = z.enum(SALE_STATUSES)
export type SaleStatus = z.output<typeof SaleStatusSchema>

export const SaleItemInputSchema = z.object({
  productId: z.uuid(),
  quantity: PositiveQuantitySchema,
  /** Ausente é FEFO (RN-04): sai o lote que vence primeiro. */
  lotId: z.uuid().nullable().optional(),
})

export const CreateSaleSchema = z
  .object({
    /** Ausente é venda avulsa: dá baixa e não toca o razão (RN-12). */
    tutorId: z.uuid().nullable().optional(),
    items: z
      .array(SaleItemInputSchema)
      .min(1, 'Inclua ao menos um produto')
      .max(50, 'Uma venda tem no máximo 50 itens'),
    /**
     * AC-06: a justificativa de quem libera a venda de tutor acima do limite de crédito.
     * Só vale com `finance:credit`, que é do administrador.
     */
    creditOverrideReason: z.string().trim().min(3).max(200).optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .superRefine((input, ctx) => {
    // O mesmo produto duas vezes no carrinho é o operador que clicou duas vezes: a
    // tela soma, e o servidor recusa, em vez de adivinhar se era para somar.
    const seen = new Set<string>()
    input.items.forEach((item, index) => {
      const key = `${item.productId}:${item.lotId ?? ''}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'productId'],
          message: 'Este produto já está na venda — ajuste a quantidade da primeira linha',
        })
      }
      seen.add(key)
    })
  })
export type CreateSaleInput = z.output<typeof CreateSaleSchema>

export const ReverseSaleSchema = z.object({
  reason: z.string().trim().min(3, 'Diga o motivo do estorno').max(200),
})
export type ReverseSaleInput = z.output<typeof ReverseSaleSchema>

export const SaleListQuerySchema = z.object({
  tutorId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type SaleListQuery = z.output<typeof SaleListQuerySchema>

export const SaleItemResponseSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  /** O nome no dia da venda: renomear o produto não reescreve o que foi vendido. */
  label: z.string(),
  unit: ProductUnitSchema,
  quantity: z.string(),
  unitPriceCents: z.number(),
  totalPriceCents: z.number(),
})
export type SaleItemResponse = z.output<typeof SaleItemResponseSchema>

export const SaleResponseSchema = z.object({
  id: z.uuid(),
  tutorId: z.uuid().nullable(),
  tutorName: z.string().nullable(),
  totalCents: z.number(),
  status: SaleStatusSchema,
  ledgerEntryId: z.uuid().nullable(),
  reversalReason: z.string().nullable(),
  reversedAt: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  items: z.array(SaleItemResponseSchema),
})
export type SaleResponse = z.output<typeof SaleResponseSchema>

export const SalePageSchema = z.object({
  items: z.array(SaleResponseSchema),
  nextCursor: z.uuid().nullable(),
})
export type SalePage = z.output<typeof SalePageSchema>

/** O que a venda devolve: a venda e se a chave já tinha gravado. */
export const SaleResultSchema = z.object({
  sale: SaleResponseSchema,
  repeated: z.boolean(),
})
export type SaleResult = z.output<typeof SaleResultSchema>

/** O corpo do `ERR_INV_010`: o que havia de cada produto que não bastou. */
export interface InsufficientStockItem {
  productId: string
  name: string
  requested: string
  available: string
}

// ─── Consumo (MOD-ESTOQUE-07/08) e rastreio de lote (MOD-ESTOQUE-10) ─────────

/**
 * A baixa de uso interno: o shampoo do banho, o algodão da tosa. Não aponta pet: é o que
 * a equipe gasta ao longo do dia, e não o que um animal recebeu.
 */
export const InternalUseSchema = z.object({
  productId: z.uuid(),
  quantity: PositiveQuantitySchema,
  /** Ausente é FEFO. */
  lotId: z.uuid().nullable().optional(),
  reason: z.string().trim().max(200).optional(),
  idempotencyKey: IdempotencyKeySchema,
})
export type InternalUseInput = z.output<typeof InternalUseSchema>

export const LotTraceEntrySchema = z.object({
  movementId: z.uuid(),
  type: z.enum(STOCK_MOVEMENT_TYPES),
  occurredAt: z.string(),
  /** Positivo: quanto o pet recebeu ou o tutor levou. */
  quantity: z.string(),
  petId: z.uuid().nullable(),
  petName: z.string().nullable(),
  tutorId: z.uuid().nullable(),
  tutorName: z.string().nullable(),
})
export type LotTraceEntry = z.output<typeof LotTraceEntrySchema>

export const LotTraceSchema = z.object({
  lot: StockLotResponseSchema,
  productName: z.string(),
  unit: ProductUnitSchema,
  entries: z.array(LotTraceEntrySchema),
})
export type LotTrace = z.output<typeof LotTraceSchema>
