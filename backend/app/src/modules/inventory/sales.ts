import { AppError, formatBRL } from '@petshop/shared-types'
import { Prisma, withTenant, type TenantTransaction } from '@petshop/db'
import type {
  CreateSaleInput,
  InsufficientStockItem,
  ReverseSaleInput,
  SaleListQuery,
  SalePage,
  SaleResponse,
  SaleResult,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { forbidden, idempotencyConflict, invalid, notFound, productInactive } from './errors.js'
import { getLedgerPort } from './ledger-port.js'
import { dateOnly, expiryWindow, quantityText } from './mapper.js'
import { fefo, lockLotsOf, type Allocation } from './lots.js'
import { recordMovement } from './movements.js'

/**
 * MOD-ESTOQUE-05/06 — a venda do balcão e o estorno dela.
 *
 * A venda nasce inteira ou não nasce: a baixa de cada lote, a linha da venda e o débito
 * `PRODUCT` no razão correm numa transação só (RN-11). Por isso não há rascunho nem
 * "venda pendente" — o carrinho vive na tela.
 */

// ─── Leitura ─────────────────────────────────────────────────────────────────

const SALE_INCLUDE = {
  items: {
    orderBy: { createdAt: 'asc' as const },
    include: { product: { select: { unit: true } } },
  },
  tutor: { select: { fullName: true, socialName: true } },
} as const

type SaleRow = Prisma.ProductSaleGetPayload<{ include: typeof SALE_INCLUDE }>

async function authorNames(tx: TenantTransaction, rows: SaleRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.createdBy).filter((id) => id !== null))]
  if (ids.length === 0) return new Map()
  const users = await tx.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  })
  return new Map(users.map((user) => [user.id, user.fullName]))
}

function toSaleResponse(row: SaleRow, names: ReadonlyMap<string, string>): SaleResponse {
  return {
    id: row.id,
    tutorId: row.tutorId,
    tutorName: row.tutor ? (row.tutor.socialName ?? row.tutor.fullName) : null,
    totalCents: Number(row.totalCents),
    status: row.status,
    ledgerEntryId: row.ledgerEntryId,
    reversalReason: row.reversalReason,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    createdByName: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    items: row.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      label: item.label,
      unit: item.product.unit,
      quantity: quantityText(item.quantity),
      unitPriceCents: Number(item.unitPriceCents),
      totalPriceCents: Number(item.totalPriceCents),
    })),
  }
}

async function loadSale(tx: TenantTransaction, id: string): Promise<SaleResponse> {
  const row = await tx.productSale.findFirst({ where: { id }, include: SALE_INCLUDE })
  if (!row) throw notFound('Venda não encontrada')
  return toSaleResponse(row, await authorNames(tx, [row]))
}

export async function getSale(actor: ActorContext, id: string): Promise<SaleResponse> {
  return withTenant(actor.tenantId, (tx) => loadSale(tx, id))
}

export async function listSales(actor: ActorContext, query: SaleListQuery): Promise<SalePage> {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.productSale.findMany({
      where: query.tutorId ? { tutorId: query.tutorId } : {},
      include: SALE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, query.limit)
    const names = await authorNames(tx, page)
    return {
      items: page.map((row) => toSaleResponse(row, names)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    }
  })
}

// ─── A venda ─────────────────────────────────────────────────────────────────

/** O texto do extrato: "Venda: Ração 15 kg, Coleira M ×2". */
function ledgerDescription(items: { label: string; quantity: Prisma.Decimal }[]): string {
  const parts = items.map((item) =>
    item.quantity.equals(1)
      ? item.label
      : `${item.label} ×${item.quantity.toString().replace('.', ',')}`,
  )
  const text = `Venda: ${parts.join(', ')}`
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`
}

/** A mesma chave com o mesmo carrinho é a mesma venda. */
function sameSale(existing: SaleRow, input: CreateSaleInput): boolean {
  if ((existing.tutorId ?? null) !== (input.tutorId ?? null)) return false
  if (existing.items.length !== input.items.length) return false
  const key = (productId: string, quantity: Prisma.Decimal | string) =>
    `${productId}:${new Prisma.Decimal(quantity).toString()}`
  const stored = existing.items.map((item) => key(item.productId, item.quantity)).sort()
  const asked = input.items.map((item) => key(item.productId, item.quantity)).sort()
  return stored.every((value, index) => value === asked[index])
}

async function replaySale(
  tx: TenantTransaction,
  input: CreateSaleInput,
): Promise<SaleResult | null> {
  const existing = await tx.productSale.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    include: SALE_INCLUDE,
  })
  if (!existing) return null
  if (!sameSale(existing, input)) throw idempotencyConflict()
  return { sale: toSaleResponse(existing, await authorNames(tx, [existing])), repeated: true }
}

function isSaleCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (error.meta as { modelName?: string } | undefined)?.modelName === 'ProductSale'
  )
}

export async function createSale(
  actor: ActorContext,
  input: CreateSaleInput,
  capabilities: { canOverrideCredit: boolean },
): Promise<SaleResult> {
  const ledger = getLedgerPort()

  let outcome: {
    saleId: string
    totalCents: number
    debit: Awaited<ReturnType<typeof ledger.postSaleDebit>> | null
  }
  try {
    const run = await withTenant(
      actor.tenantId,
      async (tx) => {
        const repeated = await replaySale(tx, input)
        if (repeated) return { kind: 'repeated' as const, result: repeated }

        const tutorId = input.tutorId ?? null
        if (tutorId) {
          const tutor = await tx.tutor.findFirst({ where: { id: tutorId }, select: { id: true } })
          if (!tutor) throw notFound('Tutor não encontrado')
        }

        // ─── Os produtos ────────────────────────────────────────────────────
        const productIds = [...new Set(input.items.map((item) => item.productId))]
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, deletedAt: null },
        })
        const byId = new Map(products.map((product) => [product.id, product]))
        for (const id of productIds) {
          const product = byId.get(id)
          if (!product) throw notFound('Um dos produtos da venda não existe')
          if (!product.active) throw productInactive()
          if (product.kind === 'SUPPLY' || product.salePriceCents === null) {
            throw invalid(`${product.name} é insumo e não se vende no balcão`)
          }
        }

        // ─── O saldo, sob trava ─────────────────────────────────────────────
        const lots = await lockLotsOf(tx, productIds)
        const { today } = await expiryWindow(tx, actor.tenantId)
        const plan: { index: number; allocations: Allocation[] }[] = []
        const short: InsufficientStockItem[] = []

        input.items.forEach((item, index) => {
          const product = byId.get(item.productId)!
          const requested = new Prisma.Decimal(item.quantity)
          const own = lots.filter((lot) => lot.product_id === item.productId)

          if (item.lotId) {
            const lot = own.find((candidate) => candidate.id === item.lotId)
            if (!lot) throw notFound('O lote escolhido não é deste produto')
            const expires = dateOnly(lot.expires_at)
            if (expires !== null && expires < today) {
              throw new AppError(
                'ERR_INV_011',
                `O lote ${lot.batch_code} de ${product.name} venceu e não pode ser vendido`,
              )
            }
            const available = new Prisma.Decimal(lot.quantity_on_hand)
            if (available.lessThan(requested)) {
              short.push({
                productId: product.id,
                name: `${product.name} (lote ${lot.batch_code})`,
                requested: requested.toString(),
                available: Prisma.Decimal.max(available, 0).toString(),
              })
            }
            plan.push({ index, allocations: [{ lotId: lot.id, quantity: requested }] })
            return
          }

          const { allocations, available } = fefo(own, requested, today)
          if (available.lessThan(requested)) {
            short.push({
              productId: product.id,
              name: product.name,
              requested: requested.toString(),
              available: available.toString(),
            })
          }
          plan.push({ index, allocations })
        })

        // AC-02: a venda inteira cai, e a resposta diz o que havia de cada um — o
        // operador corrige o carrinho de uma vez, em vez de descobrir um item por envio.
        if (short.length > 0) {
          throw new AppError(
            'ERR_INV_010',
            short.length === 1
              ? `Não há ${short[0]!.name} suficiente: há ${short[0]!.available.replace('.', ',')}`
              : `Não há saldo suficiente de ${short.length} produtos`,
            undefined,
            { items: short },
          )
        }

        // ─── O valor ────────────────────────────────────────────────────────
        const lines = input.items.map((item) => {
          const product = byId.get(item.productId)!
          const quantity = new Prisma.Decimal(item.quantity)
          const unitPriceCents = Number(product.salePriceCents)
          // Fração de centavo arredonda para o centavo mais próximo: 0,375 kg a R$ 32,90.
          const totalPriceCents = Number(
            quantity.times(unitPriceCents).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP),
          )
          return { item, product, quantity, unitPriceCents, totalPriceCents }
        })
        const totalCents = lines.reduce((sum, line) => sum + line.totalPriceCents, 0)

        // ─── O limite de crédito (AC-06) ────────────────────────────────────
        if (tutorId) {
          const status = await ledger.creditStatus(tx, actor.tenantId, tutorId)
          const debtCents = Math.max(0, -status.balanceCents)
          if (status.creditLimitCents !== null && debtCents > status.creditLimitCents) {
            if (!input.creditOverrideReason) {
              throw new AppError(
                'ERR_INV_015',
                `O tutor tem ${formatBRL(debtCents)} em aberto, acima do limite de ${formatBRL(status.creditLimitCents)}`,
                undefined,
                {
                  balanceCents: status.balanceCents,
                  creditLimitCents: status.creditLimitCents,
                  requiresOverride: true,
                },
              )
            }
            if (!capabilities.canOverrideCredit) {
              throw forbidden(
                'Somente um administrador pode liberar venda acima do limite de crédito',
              )
            }
          }
        }

        // ─── A gravação ─────────────────────────────────────────────────────
        const sale = await tx.productSale.create({
          data: {
            tenantId: actor.tenantId,
            tutorId,
            totalCents: BigInt(totalCents),
            idempotencyKey: input.idempotencyKey,
            creditOverrideReason: tutorId ? (input.creditOverrideReason ?? null) : null,
            createdBy: actor.actorUserId ?? null,
          },
        })

        for (const [position, line] of lines.entries()) {
          const saleItem = await tx.productSaleItem.create({
            data: {
              tenantId: actor.tenantId,
              saleId: sale.id,
              productId: line.product.id,
              label: line.product.name,
              quantity: line.quantity,
              unitPriceCents: BigInt(line.unitPriceCents),
              totalPriceCents: BigInt(line.totalPriceCents),
            },
          })
          const allocations = plan.find((entry) => entry.index === position)!.allocations
          for (const allocation of allocations) {
            await recordMovement(tx, actor, {
              lotId: allocation.lotId,
              type: 'SALE_OUT',
              quantity: allocation.quantity.negated(),
              sourceType: 'SALE_ITEM',
              sourceId: saleItem.id,
              tutorId,
            })
          }
        }

        const debit = tutorId
          ? await ledger.postSaleDebit(tx, actor, {
              tutorId,
              saleId: sale.id,
              amountCents: totalCents,
              description: ledgerDescription(
                lines.map((line) => ({ label: line.product.name, quantity: line.quantity })),
              ),
            })
          : null
        if (debit) {
          await tx.productSale.update({ where: { id: sale.id }, data: { ledgerEntryId: debit.id } })
        }

        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'product_sale.created',
          entity: 'product_sale',
          entityId: sale.id,
          after: {
            tutorId,
            totalCents,
            items: lines.map((line) => ({
              productId: line.product.id,
              quantity: line.quantity.toString(),
              totalPriceCents: line.totalPriceCents,
            })),
            creditOverrideReason: sale.creditOverrideReason,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })

        return { kind: 'created' as const, outcome: { saleId: sale.id, totalCents, debit } }
      },
      tenantOptions(actor),
    )
    if (run.kind === 'repeated') return run.result
    outcome = run.outcome
  } catch (error) {
    if (!isSaleCollision(error)) throw error
    // A corrida do duplo clique que passou das duas leituras e bateu no índice.
    const replayed = await withTenant(actor.tenantId, (tx) => replaySale(tx, input))
    if (!replayed) throw error
    return replayed
  }

  // Depois do commit: evento publicado de dentro da transação anunciaria uma venda que
  // ainda podia voltar atrás.
  if (outcome.debit && input.tutorId) {
    await ledger.announceDebit(actor, input.tutorId, outcome.debit)
  }
  await publishEvent('venda.registrada', {
    tenantId: actor.tenantId,
    saleId: outcome.saleId,
    tutorId: input.tutorId ?? null,
    totalCents: outcome.totalCents,
    items: input.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
  })

  return { sale: await getSale(actor, outcome.saleId), repeated: false }
}

// ─── O estorno (MOD-ESTOQUE-06) ──────────────────────────────────────────────

export async function reverseSale(
  actor: ActorContext,
  saleId: string,
  input: ReverseSaleInput,
): Promise<SaleResponse> {
  const ledger = getLedgerPort()

  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      // A trava da venda serializa dois estornos simultâneos: o segundo lê REVERSED.
      const locked = await tx.$queryRaw<
        { status: string; tutor_id: string | null; ledger_entry_id: string | null }[]
      >`
        SELECT status, tutor_id, ledger_entry_id FROM product_sales WHERE id = ${saleId}::uuid FOR UPDATE
      `
      const sale = locked[0]
      if (!sale) throw notFound('Venda não encontrada')
      if (sale.status === 'REVERSED') {
        throw new AppError('ERR_INV_012', 'Esta venda já foi estornada')
      }

      // RN-13: volta ao lote de onde saiu, e não por FEFO — a caixa devolvida é a do lote
      // que foi vendido.
      const items = await tx.productSaleItem.findMany({ where: { saleId }, select: { id: true } })
      const outs = await tx.stockMovement.findMany({
        where: {
          sourceType: 'SALE_ITEM',
          sourceId: { in: items.map((item) => item.id) },
          type: 'SALE_OUT',
        },
        orderBy: { postedAt: 'asc' },
      })
      for (const out of outs) {
        await recordMovement(tx, actor, {
          lotId: out.lotId,
          type: 'RETURN_IN',
          quantity: new Prisma.Decimal(out.quantity).negated(),
          sourceType: 'SALE_ITEM',
          sourceId: out.sourceId,
          reason: input.reason,
          tutorId: sale.tutor_id,
        })
      }

      const reversal = sale.ledger_entry_id
        ? await ledger.reverseSaleDebit(tx, actor, sale.ledger_entry_id, input.reason)
        : null

      await tx.productSale.update({
        where: { id: saleId },
        data: {
          status: 'REVERSED',
          reversalReason: input.reason,
          reversedBy: actor.actorUserId ?? null,
          reversedAt: new Date(),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'product_sale.reversed',
        entity: 'product_sale',
        entityId: saleId,
        before: { status: 'COMPLETED' },
        after: { status: 'REVERSED', reason: input.reason, ledgerReversed: reversal !== null },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { tutorId: sale.tutor_id, ledgerEntryId: sale.ledger_entry_id, reversal }
    },
    tenantOptions(actor),
  )

  if (result.reversal && result.ledgerEntryId) {
    await ledger.announceReversal(actor, result.ledgerEntryId, result.reversal, input.reason)
  }
  await publishEvent('venda.estornada', {
    tenantId: actor.tenantId,
    saleId,
    tutorId: result.tutorId,
    reason: input.reason,
    reversedBy: actor.actorUserId ?? null,
  })

  return getSale(actor, saleId)
}
