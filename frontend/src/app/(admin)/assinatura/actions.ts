'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  ChangeSubscriptionPlanSchema,
  StartCheckoutSchema,
  type CheckoutResponse,
  type SubscriptionView,
} from '@petshop/shared-types'
import type { z } from 'zod'
import { serverApi } from '@/lib/api'

/** As duas escritas da assinatura (camada comercial, fatia 4). */

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; message: string; fieldErrors: Record<string, string> }

function toFailure(error: unknown): ActionResult<never> {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

function fromZod(error: z.ZodError): ActionResult<never> {
  const fieldErrors = Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
  )
  return { ok: false, message: error.issues[0]?.message ?? 'Dados inválidos', fieldErrors }
}

/**
 * Começa o pagamento. Devolve o link, e quem navega é a tela: um `redirect` de Server
 * Action para fora do domínio não é o que a action promete a quem a chamou.
 */
export async function assinarAction(input: unknown): Promise<ActionResult<CheckoutResponse>> {
  const parsed = StartCheckoutSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().startSubscriptionCheckout(parsed.data)
    revalidatePath('/assinatura')
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

export async function trocarPlanoAction(input: unknown): Promise<ActionResult<SubscriptionView>> {
  const parsed = ChangeSubscriptionPlanSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().changeSubscriptionPlan(parsed.data)
    revalidatePath('/assinatura')
    // O plano muda o menu e as telas bloqueadas: a moldura inteira precisa reler o `/me`.
    revalidatePath('/', 'layout')
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}
