'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type { CreateServicePackageInput, UpdateServicePackageInput } from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações do catálogo de pacotes (MOD-LEDGER-07).
 *
 * Moram em Configurações desde que os pacotes saíram do Financeiro: um pacote é
 * catálogo de serviço, que se ajusta de vez em quando, e não dinheiro do dia.
 */

interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
}

type ActionResult<T> = { ok: true; data: T } | ActionFailure

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
    revalidatePath('/configuracoes/pacotes')
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
    revalidatePath('/configuracoes/pacotes')
    return { ok: true, data: updated }
  } catch (error) {
    return toFailure(error)
  }
}
