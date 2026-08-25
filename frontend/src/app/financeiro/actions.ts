'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type {
  BillingSettings,
  CreateServicePackageInput,
  UpdateBillingSettingsInput,
  UpdateServicePackageInput,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/** Ações do catálogo de pacotes e das políticas financeiras (MOD-LEDGER). */

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

export async function createPackageAction(
  input: CreateServicePackageInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const created = await serverApi().createServicePackage(input)
    revalidatePath('/financeiro/pacotes')
    return { ok: true, data: created }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updatePackageAction(
  id: string,
  input: UpdateServicePackageInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const updated = await serverApi().updateServicePackage(id, input)
    revalidatePath('/financeiro/pacotes')
    return { ok: true, data: updated }
  } catch (error) {
    return toFailure(error)
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
