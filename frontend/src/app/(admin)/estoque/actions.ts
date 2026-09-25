'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  CreateProductSchema,
  CreateSaleSchema,
  InternalUseSchema,
  ReverseSaleSchema,
  StockAdjustmentSchema,
  StockEntrySchema,
  UpdateProductSchema,
  type ProductDetailResponse,
  type LotTrace,
  type ProductResponse,
  type SalePage,
  type SaleResponse,
  type SaleResult,
  type StockMovementPage,
  type StockMovementResult,
} from '@petshop/shared-types'
import type { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações do estoque (MOD-ESTOQUE).
 *
 * Rodam no servidor: o token e a URL do gateway nunca chegam ao browser. Cada uma devolve
 * um resultado discriminado em vez de lançar, porque o formulário precisa mostrar o erro
 * no campo certo, e não uma tela de erro.
 */

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /** O código do catálogo — a venda distingue o saldo que não basta do limite de crédito. */
  code?: string
  /** O corpo do problema: o disponível por produto (`ERR_INV_010`), o `requiresOverride`. */
  problem?: Record<string, unknown>
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const problem = (error.problem ?? undefined) as Record<string, unknown> | undefined
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(problem && typeof problem.code === 'string' ? { code: problem.code, problem } : {}),
    }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

function fromZod(error: z.ZodError): ActionFailure {
  return {
    ok: false,
    message: error.issues[0]?.message ?? 'Dados inválidos',
    fieldErrors: Object.fromEntries(
      error.issues.map((issue) => [issue.path.join('.'), issue.message]),
    ),
  }
}

export async function createProductAction(
  input: unknown,
): Promise<ActionResult<ProductDetailResponse>> {
  const parsed = CreateProductSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const product = await serverApi().createProduct(parsed.data)
    revalidatePath('/estoque')
    return { ok: true, data: product }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateProductAction(
  id: string,
  input: unknown,
): Promise<ActionResult<ProductDetailResponse>> {
  const parsed = UpdateProductSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const product = await serverApi().updateProduct(id, parsed.data)
    revalidatePath('/estoque')
    revalidatePath(`/estoque/${id}`)
    return { ok: true, data: product }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deleteProductAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deleteProduct(id)
    revalidatePath('/estoque')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

export async function registerEntryAction(
  input: unknown,
): Promise<ActionResult<StockMovementResult>> {
  const parsed = StockEntrySchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().registerStockEntry(parsed.data)
    revalidatePath('/estoque')
    revalidatePath(`/estoque/${parsed.data.productId}`)
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

export async function adjustStockAction(
  productId: string,
  input: unknown,
): Promise<ActionResult<StockMovementResult>> {
  const parsed = StockAdjustmentSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().adjustStock(parsed.data)
    revalidatePath('/estoque')
    revalidatePath(`/estoque/${productId}`)
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

/** A página seguinte do histórico — o "Ver mais" da ficha. */
export async function loadMovementsAction(
  productId: string,
  cursor: string,
): Promise<ActionResult<StockMovementPage>> {
  try {
    return { ok: true, data: await serverApi().listProductMovements(productId, { cursor }) }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Venda no balcão (MOD-ESTOQUE-05/06) ─────────────────────────────────────

/** O que o balcão pode vender: ativo, de venda e com saldo. */
export async function listSellableProductsAction(): Promise<ActionResult<ProductResponse[]>> {
  try {
    const products = await serverApi().listProducts()
    return {
      ok: true,
      data: products.filter(
        (product) => product.kind !== 'SUPPLY' && product.salePriceCents !== null,
      ),
    }
  } catch (error) {
    return toFailure(error)
  }
}

export interface TutorOption {
  id: string
  name: string
  detail: string
}

/** A busca do tutor dentro do diálogo: a mesma do balcão, por nome, telefone ou CPF. */
export async function searchTutorsAction(query: string): Promise<TutorOption[]> {
  if (query.trim().length < 2) return []
  try {
    const page = await serverApi().listTutors({ q: query.trim(), limit: 6 })
    return page.data
      .filter((tutor) => tutor.status === 'ACTIVE')
      .map((tutor) => ({
        id: tutor.id,
        name: tutor.displayName,
        detail: [tutor.phoneMasked, tutor.cpfMasked].filter(Boolean).join(' · '),
      }))
  } catch {
    return []
  }
}

export async function createSaleAction(input: unknown): Promise<ActionResult<SaleResult>> {
  const parsed = CreateSaleSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().createSale(parsed.data)
    revalidatePath('/estoque')
    revalidatePath('/estoque/vendas')
    if (parsed.data.tutorId) revalidatePath(`/tutores/${parsed.data.tutorId}`)
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

export async function reverseSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<SaleResponse>> {
  const parsed = ReverseSaleSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const sale = await serverApi().reverseSale(id, parsed.data.reason)
    revalidatePath('/estoque')
    revalidatePath('/estoque/vendas')
    if (sale.tutorId) revalidatePath(`/tutores/${sale.tutorId}`)
    return { ok: true, data: sale }
  } catch (error) {
    return toFailure(error)
  }
}

export async function loadSalesAction(cursor: string): Promise<ActionResult<SalePage>> {
  try {
    return { ok: true, data: await serverApi().listSales({ cursor }) }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Uso interno e rastreio (MOD-ESTOQUE-08/10) ──────────────────────────────

export async function registerInternalUseAction(
  input: unknown,
): Promise<ActionResult<StockMovementResult>> {
  const parsed = InternalUseSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().registerInternalUse(parsed.data)
    revalidatePath('/estoque')
    revalidatePath(`/estoque/${parsed.data.productId}`)
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

export async function traceLotAction(lotId: string): Promise<ActionResult<LotTrace>> {
  try {
    return { ok: true, data: await serverApi().traceLot(lotId) }
  } catch (error) {
    return toFailure(error)
  }
}
