import { Prisma, type TenantTransaction } from '@petshop/db'
import type { StockMovementType } from '@petshop/shared-types'
import type { ActorContext } from './actor.js'
import { notFound } from './errors.js'

/**
 * RN-02 — a única porta de escrita do estoque.
 *
 * Todo movimento passa por `recordMovement`, e é ela que mexe em
 * `stock_lots.quantity_on_hand`. As duas escritas acontecem na mesma transação e sob a
 * trava da linha do lote (`FOR UPDATE`): é o que faz duas saídas simultâneas do último
 * frasco se enfileirarem em vez de lerem o mesmo saldo. Uma segunda função que
 * atualizasse o saldo "só neste caso" seria a primeira divergência que a reconciliação
 * da fatia 4 teria de explicar.
 *
 * Esta função **não recusa saldo negativo**. Quem recusa é o chamador que pode desistir
 * (a venda, na fatia 2); o atendimento não pode, porque o banho já foi dado (RN-06).
 */

export type StockSource = 'ENTRY' | 'ADJUSTMENT' | 'SALE_ITEM' | 'ATTENDANCE_ITEM' | 'INTERNAL_USE'

export interface LockedLot {
  id: string
  productId: string
  batchCode: string
  expiresAt: Date | null
  quantityOnHand: Prisma.Decimal
  unitCostCents: bigint | null
}

interface LotRow {
  id: string
  product_id: string
  batch_code: string
  expires_at: Date | null
  quantity_on_hand: Prisma.Decimal
  unit_cost_cents: bigint | null
}

function toLocked(row: LotRow): LockedLot {
  return {
    id: row.id,
    productId: row.product_id,
    batchCode: row.batch_code,
    expiresAt: row.expires_at,
    quantityOnHand: new Prisma.Decimal(row.quantity_on_hand),
    unitCostCents: row.unit_cost_cents,
  }
}

/** Trava o lote e devolve o saldo como está agora. O RLS esconde o lote alheio. */
export async function lockLot(tx: TenantTransaction, lotId: string): Promise<LockedLot> {
  const rows = await tx.$queryRaw<LotRow[]>`
    SELECT id, product_id, batch_code, expires_at, quantity_on_hand, unit_cost_cents
      FROM stock_lots
     WHERE id = ${lotId}::uuid
     FOR UPDATE
  `
  const row = rows[0]
  if (!row) throw notFound('Lote não encontrado')
  return toLocked(row)
}

/**
 * O lote do produto com este código, criado se ainda não existe, e já travado.
 *
 * `ON CONFLICT DO NOTHING` seguido da leitura com trava, e não "procura, e se não
 * achar cria": duas entradas simultâneas do mesmo lote novo colidiriam no índice único
 * e uma delas voltaria como erro 500.
 */
export async function ensureLot(
  tx: TenantTransaction,
  tenantId: string,
  productId: string,
  batchCode: string,
  expiresAt: string | null,
): Promise<{ lot: LockedLot; created: boolean }> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO stock_lots (tenant_id, product_id, batch_code, expires_at)
    VALUES (${tenantId}::uuid, ${productId}::uuid, ${batchCode}, ${expiresAt}::date)
    ON CONFLICT (tenant_id, product_id, batch_code) DO NOTHING
    RETURNING id
  `

  const rows = await tx.$queryRaw<LotRow[]>`
    SELECT id, product_id, batch_code, expires_at, quantity_on_hand, unit_cost_cents
      FROM stock_lots
     WHERE product_id = ${productId}::uuid AND batch_code = ${batchCode}
     FOR UPDATE
  `
  const row = rows[0]
  if (!row) throw notFound('Lote não encontrado')
  return { lot: toLocked(row), created: inserted.length > 0 }
}

export interface MovementInput {
  lotId: string
  type: StockMovementType
  /** Com sinal: positivo entra, negativo sai. */
  quantity: Prisma.Decimal
  sourceType: StockSource
  sourceId?: string | null
  idempotencyKey?: string | null
  reason?: string | null
  petId?: string | null
  tutorId?: string | null
  occurredAt?: Date
}

/** O movimento como o módulo o lê: a linha e o código do lote. */
export interface MovementRow {
  id: string
  lotId: string
  productId: string
  type: StockMovementType
  quantity: Prisma.Decimal
  quantityAfter: Prisma.Decimal
  reason: string | null
  createdBy: string | null
  occurredAt: Date
  postedAt: Date
  lot: { batchCode: string }
}

export async function recordMovement(
  tx: TenantTransaction,
  actor: ActorContext,
  input: MovementInput,
): Promise<MovementRow> {
  const lot = await lockLot(tx, input.lotId)
  const after = lot.quantityOnHand.plus(input.quantity)

  await tx.stockLot.update({
    where: { id: lot.id },
    data: { quantityOnHand: after },
  })

  const movement = await tx.stockMovement.create({
    data: {
      tenantId: actor.tenantId,
      lotId: lot.id,
      productId: lot.productId,
      type: input.type,
      quantity: input.quantity,
      quantityAfter: after,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      reason: input.reason ?? null,
      petId: input.petId ?? null,
      tutorId: input.tutorId ?? null,
      createdBy: actor.actorUserId ?? null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
    include: { lot: { select: { batchCode: true } } },
  })

  return movement
}

/** O movimento que uma chave já gravou, se gravou. */
export async function findByIdempotencyKey(
  tx: TenantTransaction,
  key: string,
): Promise<MovementRow | null> {
  return tx.stockMovement.findFirst({
    where: { idempotencyKey: key },
    include: { lot: { select: { batchCode: true } } },
  })
}

/**
 * O `P2002` do índice de idempotência: a corrida do duplo clique chegou ao banco.
 *
 * Reconhecido pelo **modelo**, e não pelo nome do índice: num índice parcial o Prisma
 * devolve `meta.target: null`. Em `stock_movements` o de idempotência é o único único
 * além da chave primária, que o banco gera.
 */
export function isIdempotencyCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (error.meta as { modelName?: string } | undefined)?.modelName === 'StockMovement'
  )
}
