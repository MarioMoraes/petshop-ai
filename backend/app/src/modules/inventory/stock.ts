import { Prisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  NO_BATCH_CODE,
  type StockAdjustmentInput,
  type StockEntryInput,
  type StockMovementResult,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { tenantOptions, type ActorContext } from './actor.js'
import {
  expiryRequired,
  idempotencyConflict,
  invalid,
  lotExpiryMismatch,
  notFound,
  productInactive,
} from './errors.js'
import { dateOnly, expiryWindow, toLotResponse, toMovementResponse } from './mapper.js'
import {
  ensureLot,
  findByIdempotencyKey,
  isIdempotencyCollision,
  lockLot,
  recordMovement,
  type MovementRow,
} from './movements.js'

/**
 * MOD-ESTOQUE-03/04 — o que entra e o que se corrige.
 *
 * As duas operações recebem uma `idempotencyKey` gerada pela tela ao abrir o formulário.
 * A mesma chave com o mesmo conteúdo devolve o movimento já gravado (`repeated: true`), e
 * com outro conteúdo é 409. Esta é a guarda do duplo clique, e não uma API de retentativa:
 * não há hash do corpo como no MOD-LEDGER, porque o que distingue uma entrada de outra
 * cabe em três campos.
 */

type Movement = MovementRow

async function result(
  tx: TenantTransaction,
  tenantId: string,
  movement: Movement,
  repeated: boolean,
): Promise<StockMovementResult> {
  const window = await expiryWindow(tx, tenantId)
  const lot = await tx.stockLot.findUniqueOrThrow({ where: { id: movement.lotId } })
  return {
    movement: toMovementResponse(movement),
    lot: toLotResponse(lot, window),
    repeated,
  }
}

/**
 * A repetição de uma chave: devolve o que ela gravou, ou recusa se o pedido é outro.
 *
 * `same` compara só o que a tela não muda sem querer. O motivo digitado de novo com uma
 * vírgula a mais continua sendo o mesmo ajuste.
 */
async function replay(
  tx: TenantTransaction,
  tenantId: string,
  key: string,
  same: (movement: Movement) => boolean,
): Promise<StockMovementResult | null> {
  const existing = await findByIdempotencyKey(tx, key)
  if (!existing) return null
  if (!same(existing)) throw idempotencyConflict()
  return result(tx, tenantId, existing, true)
}

/** A corrida do duplo clique que passou das duas leituras e bateu no índice. */
async function withReplayOnCollision(
  actor: ActorContext,
  key: string,
  run: () => Promise<StockMovementResult>,
  same: (movement: Movement) => boolean,
): Promise<StockMovementResult> {
  try {
    return await run()
  } catch (error) {
    if (!isIdempotencyCollision(error)) throw error
    const replayed = await withTenant(actor.tenantId, (tx) => replay(tx, actor.tenantId, key, same))
    if (!replayed) throw error
    return replayed
  }
}

// ─── Entrada (MOD-ESTOQUE-03) ────────────────────────────────────────────────

export async function registerEntry(
  actor: ActorContext,
  input: StockEntryInput,
): Promise<StockMovementResult> {
  const quantity = new Prisma.Decimal(input.quantity)
  const same = (movement: Movement) =>
    movement.type === 'PURCHASE_IN' &&
    movement.productId === input.productId &&
    movement.quantity.equals(quantity)

  return withReplayOnCollision(
    actor,
    input.idempotencyKey,
    () =>
      withTenant(
        actor.tenantId,
        async (tx) => {
          const repeated = await replay(tx, actor.tenantId, input.idempotencyKey, same)
          if (repeated) return repeated

          const product = await tx.product.findFirst({
            where: { id: input.productId, deletedAt: null },
          })
          if (!product) throw notFound()
          if (!product.active) throw productInactive()

          const expiresAt = input.expiresAt ?? null
          if (product.tracksExpiry && !expiresAt) throw expiryRequired()

          const batchCode = input.batchCode ?? NO_BATCH_CODE
          const { lot, created } = await ensureLot(
            tx,
            actor.tenantId,
            product.id,
            batchCode,
            expiresAt,
          )

          // AC-02: lote com duas validades é erro de digitação. O lote que entrou sem
          // data (produto que não controlava validade) ganha a primeira que aparecer.
          const lotExpiry = dateOnly(lot.expiresAt)
          if (!created && expiresAt && lotExpiry && lotExpiry !== expiresAt) {
            throw lotExpiryMismatch(batchCode, lotExpiry)
          }

          // O custo do lote é a média ponderada das entradas dele. O do produto é o da
          // última entrada (RN-09) — é o número que o petshop reconhece da nota.
          const unitCost = input.unitCostCents ?? null
          let lotCost = lot.unitCostCents
          if (unitCost !== null) {
            const onHand = Prisma.Decimal.max(lot.quantityOnHand, 0)
            lotCost =
              lot.unitCostCents === null || onHand.isZero()
                ? BigInt(unitCost)
                : BigInt(
                    onHand
                      .times(lot.unitCostCents.toString())
                      .plus(quantity.times(unitCost))
                      .dividedBy(onHand.plus(quantity))
                      .toDecimalPlaces(0)
                      .toString(),
                  )
          }

          if (lotCost !== lot.unitCostCents || (!lotExpiry && expiresAt)) {
            await tx.stockLot.update({
              where: { id: lot.id },
              data: {
                unitCostCents: lotCost,
                ...(!lotExpiry && expiresAt
                  ? { expiresAt: new Date(`${expiresAt}T00:00:00Z`) }
                  : {}),
              },
            })
          }
          if (unitCost !== null) {
            await tx.product.update({
              where: { id: product.id },
              data: { costCents: BigInt(unitCost) },
            })
          }

          const movement = await recordMovement(tx, actor, {
            lotId: lot.id,
            type: 'PURCHASE_IN',
            quantity,
            sourceType: 'ENTRY',
            idempotencyKey: input.idempotencyKey,
            ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
          })

          await recordAudit(tx, {
            tenantId: actor.tenantId,
            actorUserId: actor.actorUserId ?? null,
            action: 'stock.entry',
            entity: 'product',
            entityId: product.id,
            after: {
              batchCode,
              expiresAt,
              quantity: quantity.toString(),
              unitCostCents: unitCost,
            },
            ipAddress: actor.ipAddress ?? null,
            userAgent: actor.userAgent ?? null,
          })

          return result(tx, actor.tenantId, movement, false)
        },
        tenantOptions(actor),
      ),
    same,
  )
}

// ─── Ajuste e perda (MOD-ESTOQUE-04) ─────────────────────────────────────────

export async function adjustStock(
  actor: ActorContext,
  input: StockAdjustmentInput,
): Promise<StockMovementResult> {
  const same = (movement: Movement) =>
    movement.lotId === input.lotId && movement.type === input.type

  return withReplayOnCollision(
    actor,
    input.idempotencyKey,
    () =>
      withTenant(
        actor.tenantId,
        async (tx) => {
          const repeated = await replay(tx, actor.tenantId, input.idempotencyKey, same)
          if (repeated) return repeated

          const lot = await lockLot(tx, input.lotId)
          const product = await tx.product.findFirst({
            where: { id: lot.productId, deletedAt: null },
            select: { id: true },
          })
          if (!product) throw notFound()

          // AC-02: quem conta informa o saldo, e a diferença sai daqui — sob a trava do
          // lote, para uma venda no meio da contagem não virar ajuste errado.
          const informed = new Prisma.Decimal(input.quantity)
          const delta = input.mode === 'COUNT' ? informed.minus(lot.quantityOnHand) : informed

          if (delta.isZero()) {
            throw invalid('O saldo contado é igual ao registrado — não há o que ajustar', [
              { field: 'quantity', message: 'Igual ao saldo atual' },
            ])
          }
          if (input.type === 'LOSS' && delta.greaterThan(0)) {
            throw invalid(
              'Perda é uma saída — o saldo contado precisa ser menor que o registrado',
              [{ field: 'quantity', message: 'Maior que o saldo atual' }],
            )
          }

          const movement = await recordMovement(tx, actor, {
            lotId: lot.id,
            type: input.type,
            quantity: delta,
            sourceType: 'ADJUSTMENT',
            idempotencyKey: input.idempotencyKey,
            reason: input.reason,
          })

          await recordAudit(tx, {
            tenantId: actor.tenantId,
            actorUserId: actor.actorUserId ?? null,
            action: input.type === 'LOSS' ? 'stock.loss' : 'stock.adjusted',
            entity: 'product',
            entityId: product.id,
            before: { batchCode: lot.batchCode, quantityOnHand: lot.quantityOnHand.toString() },
            after: {
              batchCode: lot.batchCode,
              quantityOnHand: lot.quantityOnHand.plus(delta).toString(),
              reason: input.reason,
            },
            ipAddress: actor.ipAddress ?? null,
            userAgent: actor.userAgent ?? null,
          })

          return result(tx, actor.tenantId, movement, false)
        },
        tenantOptions(actor),
      ),
    same,
  )
}
