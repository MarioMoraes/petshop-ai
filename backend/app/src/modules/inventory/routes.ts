import {
  CreateProductSchema,
  CreateSaleSchema,
  InternalUseSchema,
  MovementListQuerySchema,
  ProductListQuerySchema,
  ReverseSaleSchema,
  SaleListQuerySchema,
  StockAdjustmentSchema,
  StockEntrySchema,
  UpdateProductSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ActorContext } from './actor.js'
import { hasPermission, requirePermission, requireTenantContext } from './auth.js'
import {
  createProduct,
  deleteProduct,
  getProduct,
  listMovements,
  listProducts,
  updateProduct,
} from './products.js'
import { registerInternalUse, traceLot } from './consumption.js'
import { createSale, getSale, listSales, reverseSale } from './sales.js'
import { adjustStock, registerEntry } from './stock.js'
import { parseInput } from './validate.js'

/**
 * Rotas do MOD-ESTOQUE (PRD estoque_16 §5), todas sob `/v1/inventory`.
 *
 * O prefixo está em `PLAN_GATES`, e é ele que dá o 402 no Starter: rota nova aqui nasce
 * bloqueada sem ninguém lembrar. A leitura é de toda a equipe que atende
 * (`inventory:read`). A escrita — cadastro, entrada e ajuste — é do administrador
 * (`inventory:write`), porque mexe no custo e na contagem.
 */

const IdParamSchema = z.object({ id: z.uuid() })

function actorFrom(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId ?? undefined,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  }
}

const READ = { preHandler: requirePermission('inventory:read') }
const WRITE = { preHandler: requirePermission('inventory:write') }
const SELL = { preHandler: requirePermission('inventory:sell') }
const REFUND = { preHandler: requirePermission('inventory:refund') }
const CONSUME = { preHandler: requirePermission('inventory:consume') }
/**
 * O rastreio de lote lista pets e tutores: é prontuário lido pelo avesso, e pede a
 * leitura do resumo do prontuário além do estoque.
 */
const TRACE = {
  preHandler: [requirePermission('inventory:read'), requirePermission('record:read_summary')],
}

export async function registerInventoryRoutes(app: FastifyInstance): Promise<void> {
  // ─── Produtos (MOD-ESTOQUE-01) ─────────────────────────────────────────────

  app.get('/v1/inventory/products', READ, async (request) => {
    const query = parseInput(ProductListQuerySchema, request.query)
    return listProducts(actorFrom(request), query)
  })

  app.post('/v1/inventory/products', WRITE, async (request, reply) => {
    const input = parseInput(CreateProductSchema, request.body)
    const product = await createProduct(actorFrom(request), input)
    return reply.status(201).send(product)
  })

  app.get('/v1/inventory/products/:id', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getProduct(actorFrom(request), id)
  })

  app.patch('/v1/inventory/products/:id', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(UpdateProductSchema, request.body)
    return updateProduct(actorFrom(request), id, input)
  })

  app.delete('/v1/inventory/products/:id', WRITE, async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await deleteProduct(actorFrom(request), id)
    return reply.status(204).send()
  })

  app.get('/v1/inventory/products/:id/movements', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const query = parseInput(MovementListQuerySchema, request.query)
    return listMovements(actorFrom(request), id, query)
  })

  // ─── Entrada e ajuste (MOD-ESTOQUE-03/04) ──────────────────────────────────

  app.post('/v1/inventory/entries', WRITE, async (request, reply) => {
    const input = parseInput(StockEntrySchema, request.body)
    const result = await registerEntry(actorFrom(request), input)
    return reply.status(result.repeated ? 200 : 201).send(result)
  })

  app.post('/v1/inventory/adjustments', WRITE, async (request, reply) => {
    const input = parseInput(StockAdjustmentSchema, request.body)
    const result = await adjustStock(actorFrom(request), input)
    return reply.status(result.repeated ? 200 : 201).send(result)
  })

  // ─── Uso interno e rastreio (MOD-ESTOQUE-08/10) ─────────────────────────────

  app.post('/v1/inventory/internal-use', CONSUME, async (request, reply) => {
    const input = parseInput(InternalUseSchema, request.body)
    const result = await registerInternalUse(actorFrom(request), input)
    return reply.status(result.repeated ? 200 : 201).send(result)
  })

  app.get('/v1/inventory/lots/:id/trace', TRACE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return traceLot(actorFrom(request), id)
  })

  // ─── Venda no balcão (MOD-ESTOQUE-05/06) ───────────────────────────────────
  //
  // A lista de vendas é de quem lê o estoque **e** vende: a recepção precisa achar a
  // venda de ontem para conferir. O estorno é só do administrador (`inventory:refund`).

  app.get('/v1/inventory/sales', SELL, async (request) => {
    const query = parseInput(SaleListQuerySchema, request.query)
    return listSales(actorFrom(request), query)
  })

  app.get('/v1/inventory/sales/:id', SELL, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getSale(actorFrom(request), id)
  })

  app.post('/v1/inventory/sales', SELL, async (request, reply) => {
    const input = parseInput(CreateSaleSchema, request.body)
    // AC-06: liberar a venda de quem passou do limite é conceder crédito, e
    // `finance:credit` é do administrador — a mesma permissão do crédito manual.
    const result = await createSale(actorFrom(request), input, {
      canOverrideCredit: hasPermission(request, 'finance:credit'),
    })
    return reply.status(result.repeated ? 200 : 201).send(result)
  })

  app.post('/v1/inventory/sales/:id/reverse', REFUND, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(ReverseSaleSchema, request.body)
    return reverseSale(actorFrom(request), id, input)
  })
}
