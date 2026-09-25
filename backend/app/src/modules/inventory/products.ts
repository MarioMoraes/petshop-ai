import { Prisma, withTenant, type TenantTransaction } from '@petshop/db'
import type {
  CreateProductInput,
  MovementListQuery,
  ProductDetailResponse,
  ProductKind,
  ProductListQuery,
  ProductResponse,
  StockMovementPage,
  UpdateProductInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { invalidateInventoryAlerts } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { invalid, notFound, productHasHistory } from './errors.js'
import {
  expiryWindow,
  toLotResponse,
  toMovementResponse,
  toProductResponse,
  type ExpiryWindow,
} from './mapper.js'

/**
 * MOD-ESTOQUE-01 — o cadastro do produto.
 *
 * O produto não guarda saldo (RN-03): toda leitura traz os lotes junto, e o saldo é a
 * soma deles. A lista é montada em memória e não por `GROUP BY` — o catálogo de um
 * petshop tem centenas de itens, não centenas de milhares, e o filtro de alerta precisa
 * das mesmas contas que a resposta mostra. Se a lista crescer a ponto de pesar, a troca
 * é por uma consulta agregada com as mesmas regras de `toProductResponse`.
 */

export const LOTS_FOR_TOTALS = {
  lots: {
    select: {
      id: true,
      batchCode: true,
      expiresAt: true,
      quantityOnHand: true,
      unitCostCents: true,
    },
  },
} as const

function sellable(kind: ProductKind): boolean {
  return kind === 'RETAIL' || kind === 'BOTH'
}

/**
 * O `P2002` do índice parcial de SKU vira um 422 no campo, e não um 500.
 *
 * Reconhecido pelo modelo: num índice parcial o Prisma devolve `meta.target: null`, e o
 * de SKU é o único índice único de `products`.
 */
function isSkuCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (error.meta as { modelName?: string } | undefined)?.modelName === 'Product'
  )
}

function skuTaken() {
  return invalid('Já existe um produto com este SKU', [
    { field: 'sku', message: 'SKU já usado em outro produto' },
  ])
}

async function loadProduct(tx: TenantTransaction, id: string) {
  const product = await tx.product.findFirst({
    where: { id, deletedAt: null },
    include: LOTS_FOR_TOTALS,
  })
  if (!product) throw notFound()
  return product
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function listProducts(
  actor: ActorContext,
  query: ProductListQuery,
): Promise<ProductResponse[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const window = await expiryWindow(tx, actor.tenantId)
    const q = query.q?.trim()

    const products = await tx.product.findMany({
      where: {
        deletedAt: null,
        ...(query.includeInactive ? {} : { active: true }),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { sku: { equals: q, mode: 'insensitive' as const } },
                { barcode: q },
              ],
            }
          : {}),
      },
      include: LOTS_FOR_TOTALS,
      orderBy: { name: 'asc' },
    })

    const rows = products.map((product) => toProductResponse(product, window))
    switch (query.alert) {
      case 'LOW':
        return rows.filter((row) => row.belowMinimum)
      case 'EXPIRING':
        return rows.filter((row) => row.expiringLots > 0)
      case 'NEGATIVE':
        return rows.filter((row) => Number(row.quantityOnHand) < 0)
      default:
        return rows
    }
  })
}

async function detail(
  tx: TenantTransaction,
  id: string,
  window: ExpiryWindow,
): Promise<ProductDetailResponse> {
  const product = await loadProduct(tx, id)
  const movements = await tx.stockMovement.count({ where: { productId: id } })

  // O lote zerado há mais de 90 dias é arquivo: fica no histórico de movimentos, não
  // na lista que o operador lê para saber o que tem.
  const archiveBefore = new Date(Date.now() - 90 * 86_400_000)
  const lots = await tx.stockLot.findMany({
    where: {
      productId: id,
      OR: [{ quantityOnHand: { not: 0 } }, { updatedAt: { gte: archiveBefore } }],
    },
    orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  })

  return {
    ...toProductResponse(product, window),
    lots: lots.map((lot) => toLotResponse(lot, window)),
    deletable: movements === 0,
  }
}

export async function getProduct(actor: ActorContext, id: string): Promise<ProductDetailResponse> {
  return withTenant(actor.tenantId, async (tx) =>
    detail(tx, id, await expiryWindow(tx, actor.tenantId)),
  )
}

export async function listMovements(
  actor: ActorContext,
  productId: string,
  query: MovementListQuery,
): Promise<StockMovementPage> {
  return withTenant(actor.tenantId, async (tx) => {
    await loadProduct(tx, productId)

    const rows = await tx.stockMovement.findMany({
      where: { productId },
      include: { lot: { select: { batchCode: true } } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })

    const page = rows.slice(0, query.limit)
    const authorIds = [...new Set(page.map((row) => row.createdBy).filter((id) => id !== null))]
    const authors = authorIds.length
      ? await tx.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, fullName: true },
        })
      : []
    const names = new Map(authors.map((user) => [user.id, user.fullName]))

    return {
      items: page.map((row) => toMovementResponse(row, names)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    }
  })
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

export async function createProduct(
  actor: ActorContext,
  input: CreateProductInput,
): Promise<ProductDetailResponse> {
  try {
    return await withTenant(
      actor.tenantId,
      async (tx) => {
        const product = await tx.product.create({
          data: {
            tenantId: actor.tenantId,
            name: input.name,
            sku: input.sku ?? null,
            barcode: input.barcode ?? null,
            kind: input.kind,
            unit: input.unit,
            // Insumo não tem preço de venda: o campo que a tela deixou preenchido ao
            // trocar o tipo não vira um preço fantasma.
            salePriceCents:
              sellable(input.kind) && input.salePriceCents != null
                ? BigInt(input.salePriceCents)
                : null,
            costCents: input.costCents != null ? BigInt(input.costCents) : null,
            minQuantity: new Prisma.Decimal(input.minQuantity),
            tracksExpiry: input.tracksExpiry,
            createdBy: actor.actorUserId ?? null,
          },
        })

        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'product.created',
          entity: 'product',
          entityId: product.id,
          after: {
            name: product.name,
            kind: product.kind,
            unit: product.unit,
            salePriceCents: input.salePriceCents ?? null,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })

        // O produto novo com ponto de reposição nasce abaixo dele: é um alerta.
        await invalidateInventoryAlerts(actor.tenantId)
        return detail(tx, product.id, await expiryWindow(tx, actor.tenantId))
      },
      tenantOptions(actor),
    )
  } catch (error) {
    if (isSkuCollision(error)) throw skuTaken()
    throw error
  }
}

export async function updateProduct(
  actor: ActorContext,
  id: string,
  input: UpdateProductInput,
): Promise<ProductDetailResponse> {
  try {
    return await withTenant(
      actor.tenantId,
      async (tx) => {
        const current = await loadProduct(tx, id)
        const kind = input.kind ?? current.kind

        // AC-02 contra o estado **resultante**: trocar insumo por venda sem mandar o
        // preço, ou apagar o preço de um produto de venda, dá no mesmo produto sem preço.
        const price =
          input.salePriceCents !== undefined
            ? input.salePriceCents
            : current.salePriceCents === null
              ? null
              : Number(current.salePriceCents)
        if (sellable(kind) && price === null) {
          throw invalid('Produto de venda precisa de preço', [
            { field: 'salePriceCents', message: 'Produto de venda precisa de preço' },
          ])
        }

        // A unidade é o significado de todo número já gravado: 500 "ml" que viram 500
        // "unidades" reescrevem o passado sem movimento nenhum.
        if (input.unit && input.unit !== current.unit) {
          const moved = await tx.stockMovement.count({ where: { productId: id } })
          if (moved > 0) {
            throw invalid('A unidade não muda depois que o produto teve movimento', [
              { field: 'unit', message: 'Cadastre um produto novo com a outra unidade' },
            ])
          }
        }

        const updated = await tx.product.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.sku !== undefined ? { sku: input.sku } : {}),
            ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(input.unit !== undefined ? { unit: input.unit } : {}),
            salePriceCents: sellable(kind) && price !== null ? BigInt(price) : null,
            ...(input.costCents !== undefined
              ? { costCents: input.costCents === null ? null : BigInt(input.costCents) }
              : {}),
            ...(input.minQuantity !== undefined
              ? { minQuantity: new Prisma.Decimal(input.minQuantity) }
              : {}),
            ...(input.tracksExpiry !== undefined ? { tracksExpiry: input.tracksExpiry } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        })

        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action:
            input.active === false && current.active ? 'product.deactivated' : 'product.updated',
          entity: 'product',
          entityId: id,
          before: {
            name: current.name,
            kind: current.kind,
            salePriceCents: current.salePriceCents === null ? null : Number(current.salePriceCents),
            active: current.active,
          },
          after: {
            name: updated.name,
            kind: updated.kind,
            salePriceCents: updated.salePriceCents === null ? null : Number(updated.salePriceCents),
            active: updated.active,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })

        // Mínimo, ativo e validade mudam o que conta como alerta.
        await invalidateInventoryAlerts(actor.tenantId)
        return detail(tx, id, await expiryWindow(tx, actor.tenantId))
      },
      tenantOptions(actor),
    )
  } catch (error) {
    if (isSkuCollision(error)) throw skuTaken()
    throw error
  }
}

/**
 * AC-03: só o produto que nunca se moveu é excluído — e a exclusão é lógica, para que
 * o SKU volte a ficar livre (índice parcial) sem apagar a linha que a trilha cita.
 */
export async function deleteProduct(actor: ActorContext, id: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const current = await loadProduct(tx, id)
      const moved = await tx.stockMovement.count({ where: { productId: id } })
      if (moved > 0) throw productHasHistory()

      await tx.product.update({ where: { id }, data: { deletedAt: new Date(), active: false } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'product.deleted',
        entity: 'product',
        entityId: id,
        before: { name: current.name, kind: current.kind },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
      await invalidateInventoryAlerts(actor.tenantId)
    },
    tenantOptions(actor),
  )
}
