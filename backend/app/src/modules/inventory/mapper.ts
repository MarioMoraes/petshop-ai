import { Prisma, type TenantTransaction } from '@petshop/db'
import {
  addDays,
  DEFAULT_TIMEZONE,
  INVENTORY_EXPIRY_WARNING_DAYS,
  todayIn,
  type ProductKind,
  type ProductResponse,
  type ProductUnit,
  type StockLotResponse,
  type StockMovementResponse,
  type StockMovementType,
} from '@petshop/shared-types'

/**
 * A régua das datas do estoque.
 *
 * "Hoje" é o dia **no fuso do estabelecimento**: às 22h de Brasília já é amanhã em UTC,
 * e o lote que vence hoje apareceria vencido uma noite antes.
 */
export interface ExpiryWindow {
  today: string
  warnUntil: string
  /** A janela configurada (fatia 4), para quem precisa anunciá-la. */
  days: number
  timezone: string
}

/**
 * O fuso vem de `tenant_settings`, que é do MOD-IDENT, e a janela de
 * `inventory_settings`, que é deste módulo. A linha ausente vale o padrão.
 */
export async function expiryWindow(tx: TenantTransaction, tenantId: string): Promise<ExpiryWindow> {
  const [settings, inventory] = await Promise.all([
    tx.tenantSettings.findFirst({ where: { tenantId }, select: { timezone: true } }),
    tx.inventorySettings.findFirst({ where: { tenantId }, select: { expiryWarningDays: true } }),
  ])
  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE
  const days = inventory?.expiryWarningDays ?? INVENTORY_EXPIRY_WARNING_DAYS
  const today = todayIn(timezone)
  return { today, warnUntil: addDays(today, days), days, timezone }
}

/** `2027-03-31T00:00:00.000Z` (coluna `DATE`) → `2027-03-31`. */
export function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

/** O `Decimal` sem zeros à direita: `12.500` → `"12.5"`, `3.000` → `"3"`. */
export function quantityText(value: Prisma.Decimal | string | number): string {
  return new Prisma.Decimal(value).toString()
}

interface LotLike {
  id: string
  batchCode: string
  expiresAt: Date | null
  quantityOnHand: Prisma.Decimal
  unitCostCents: bigint | null
}

export function toLotResponse(lot: LotLike, window: ExpiryWindow): StockLotResponse {
  const expiresAt = dateOnly(lot.expiresAt)
  const hasStock = new Prisma.Decimal(lot.quantityOnHand).greaterThan(0)
  return {
    id: lot.id,
    batchCode: lot.batchCode,
    expiresAt,
    quantityOnHand: quantityText(lot.quantityOnHand),
    unitCostCents: lot.unitCostCents === null ? null : Number(lot.unitCostCents),
    expired: hasStock && expiresAt !== null && expiresAt < window.today,
    expiring:
      hasStock && expiresAt !== null && expiresAt >= window.today && expiresAt <= window.warnUntil,
  }
}

interface ProductLike {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  kind: ProductKind
  unit: ProductUnit
  salePriceCents: bigint | null
  costCents: bigint | null
  minQuantity: Prisma.Decimal
  tracksExpiry: boolean
  active: boolean
  createdAt: Date
  updatedAt: Date
  lots: LotLike[]
}

export function toProductResponse(product: ProductLike, window: ExpiryWindow): ProductResponse {
  const total = product.lots.reduce(
    (sum, lot) => sum.plus(lot.quantityOnHand),
    new Prisma.Decimal(0),
  )

  // A validade que importa é a do que ainda está na prateleira.
  const stocked = product.lots.filter((lot) =>
    new Prisma.Decimal(lot.quantityOnHand).greaterThan(0),
  )
  const expiries = stocked
    .map((lot) => dateOnly(lot.expiresAt))
    .filter((value): value is string => value !== null)
    .sort()

  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    kind: product.kind,
    unit: product.unit,
    salePriceCents: product.salePriceCents === null ? null : Number(product.salePriceCents),
    costCents: product.costCents === null ? null : Number(product.costCents),
    minQuantity: quantityText(product.minQuantity),
    tracksExpiry: product.tracksExpiry,
    active: product.active,
    quantityOnHand: quantityText(total),
    nextExpiresAt: expiries[0] ?? null,
    // Ponto de reposição zero é "não controlo reposição", e não "sempre abaixo".
    belowMinimum:
      new Prisma.Decimal(product.minQuantity).greaterThan(0) && total.lessThan(product.minQuantity),
    expiringLots: expiries.filter((value) => value <= window.warnUntil).length,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  }
}

interface MovementLike {
  id: string
  lotId: string
  type: StockMovementType
  quantity: Prisma.Decimal
  quantityAfter: Prisma.Decimal
  reason: string | null
  createdBy: string | null
  occurredAt: Date
  postedAt: Date
  lot: { batchCode: string }
}

export function toMovementResponse(
  movement: MovementLike,
  names: ReadonlyMap<string, string> = new Map(),
): StockMovementResponse {
  return {
    id: movement.id,
    lotId: movement.lotId,
    batchCode: movement.lot.batchCode,
    type: movement.type,
    quantity: quantityText(movement.quantity),
    quantityAfter: quantityText(movement.quantityAfter),
    reason: movement.reason,
    createdByName: movement.createdBy ? (names.get(movement.createdBy) ?? null) : null,
    occurredAt: movement.occurredAt.toISOString(),
    postedAt: movement.postedAt.toISOString(),
  }
}
