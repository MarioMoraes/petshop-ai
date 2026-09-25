'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  CashAdjustmentSchema,
  CloseCashSessionSchema,
  OpenCashSessionSchema,
  type CashSessionDetail,
} from '@petshop/shared-types'
import type { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações do caixa do dia (MOD-CAIXA).
 *
 * Devolvem resultado discriminado em vez de lançar: o diálogo mostra o erro no campo
 * certo — a sangria acima do que há na gaveta, a diferença sem justificativa.
 */

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  code?: string
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const problem = (error.problem ?? undefined) as { code?: unknown } | undefined
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(typeof problem?.code === 'string' ? { code: problem.code } : {}),
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

/** A tela do caixa e o "Recebido hoje" do Início mudam juntos. */
function revalidate() {
  revalidatePath('/caixa', 'layout')
  revalidatePath('/dashboard')
}

export async function openCashAction(input: unknown): Promise<ActionResult<CashSessionDetail>> {
  const parsed = OpenCashSessionSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  try {
    const session = await serverApi().openCash(parsed.data.openingFloatCents)
    revalidate()
    return { ok: true, data: session }
  } catch (error) {
    return toFailure(error)
  }
}

export async function adjustCashAction(input: unknown): Promise<ActionResult<CashSessionDetail>> {
  const parsed = CashAdjustmentSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  try {
    const session = await serverApi().adjustCash(parsed.data)
    revalidate()
    return { ok: true, data: session }
  } catch (error) {
    return toFailure(error)
  }
}

export async function closeCashAction(
  sessionId: string,
  input: unknown,
): Promise<ActionResult<CashSessionDetail>> {
  const parsed = CloseCashSessionSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)
  try {
    const session = await serverApi().closeCash(sessionId, parsed.data)
    revalidate()
    return { ok: true, data: session }
  } catch (error) {
    return toFailure(error)
  }
}
