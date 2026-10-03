import {
  ProductDetailResponseSchema,
  ProductResponseSchema,
  StockMovementPageSchema,
  StockMovementResultSchema,
  SalePageSchema,
  SaleResponseSchema,
  SaleResultSchema,
  LotTraceSchema,
  InventoryAlertsSchema,
  InventorySettingsSchema,
  InventoryPositionReportSchema,
  type CreateProductSchema,
  type InternalUseSchema,
  type CreateSaleSchema,
  type ProductListQuerySchema,
  type StockAdjustmentSchema,
  type StockEntrySchema,
  type UpdateProductSchema,
  type UpdateInventorySettingsInput,
  type PositionReportQuery,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function inventoryEndpoints({ request }: Transport) {
  return {
    // ─── MOD-ESTOQUE — produto, lote e movimento ───────────────────────────
    //
    // Os corpos são tipados pela **entrada** do schema (`z.input`): unidade, mínimo e
    // validade têm padrão, e quem os omite recebe o padrão do servidor.

    listProducts: (query: Partial<z.input<typeof ProductListQuerySchema>> = {}) =>
      request({
        method: 'GET',
        path: `/v1/inventory/products${toQueryString(query)}`,
        schema: z.array(ProductResponseSchema),
      }),

    getProduct: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/inventory/products/${id}`,
        schema: ProductDetailResponseSchema,
      }),

    createProduct: (input: z.input<typeof CreateProductSchema>) =>
      request({
        method: 'POST',
        path: '/v1/inventory/products',
        body: input,
        schema: ProductDetailResponseSchema,
      }),

    updateProduct: (id: string, patch: z.input<typeof UpdateProductSchema>) =>
      request({
        method: 'PATCH',
        path: `/v1/inventory/products/${id}`,
        body: patch,
        schema: ProductDetailResponseSchema,
      }),

    deleteProduct: (id: string) =>
      request<void>({ method: 'DELETE', path: `/v1/inventory/products/${id}` }),

    listProductMovements: (id: string, query: { cursor?: string; limit?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/inventory/products/${id}/movements${toQueryString(query)}`,
        schema: StockMovementPageSchema,
      }),

    registerStockEntry: (input: z.input<typeof StockEntrySchema>) =>
      request({
        method: 'POST',
        path: '/v1/inventory/entries',
        body: input,
        schema: StockMovementResultSchema,
      }),

    adjustStock: (input: z.input<typeof StockAdjustmentSchema>) =>
      request({
        method: 'POST',
        path: '/v1/inventory/adjustments',
        body: input,
        schema: StockMovementResultSchema,
      }),

    listSales: (query: { tutorId?: string; cursor?: string; limit?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/inventory/sales${toQueryString(query)}`,
        schema: SalePageSchema,
      }),

    getSale: (id: string) =>
      request({ method: 'GET', path: `/v1/inventory/sales/${id}`, schema: SaleResponseSchema }),

    createSale: (input: z.input<typeof CreateSaleSchema>) =>
      request({
        method: 'POST',
        path: '/v1/inventory/sales',
        body: input,
        schema: SaleResultSchema,
      }),

    registerInternalUse: (input: z.input<typeof InternalUseSchema>) =>
      request({
        method: 'POST',
        path: '/v1/inventory/internal-use',
        body: input,
        schema: StockMovementResultSchema,
      }),

    traceLot: (lotId: string) =>
      request({ method: 'GET', path: `/v1/inventory/lots/${lotId}/trace`, schema: LotTraceSchema }),

    reverseSale: (id: string, reason: string) =>
      request({
        method: 'POST',
        path: `/v1/inventory/sales/${id}/reverse`,
        body: { reason },
        schema: SaleResponseSchema,
      }),

    // ─── MOD-ESTOQUE — alertas, configuração e posição (fatia 4) ─────────────

    /** As contagens do sino: o tamanho de cada lista filtrada de `/estoque`. */
    getInventoryAlerts: () =>
      request({ method: 'GET', path: '/v1/inventory/alerts', schema: InventoryAlertsSchema }),

    getInventorySettings: () =>
      request({ method: 'GET', path: '/v1/inventory/settings', schema: InventorySettingsSchema }),

    updateInventorySettings: (input: UpdateInventorySettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/inventory/settings',
        body: input,
        schema: InventorySettingsSchema,
      }),

    getInventoryPosition: (query: Partial<PositionReportQuery> = {}) =>
      request({
        method: 'GET',
        path: `/v1/inventory/reports/position${toQueryString(query)}`,
        schema: InventoryPositionReportSchema,
      }),
  }
}
