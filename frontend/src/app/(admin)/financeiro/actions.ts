'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type { BillingSettings, UpdateBillingSettingsInput } from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/** Ações das políticas financeiras (MOD-LEDGER). */

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

export async function updateBillingSettingsAction(
  input: UpdateBillingSettingsInput,
): Promise<ActionResult<BillingSettings>> {
  try {
    const settings = await serverApi().updateBillingSettings(input)
    revalidatePath('/financeiro/configuracoes')
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}
