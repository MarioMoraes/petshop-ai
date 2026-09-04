'use server'

import type { PortalStatementResponse } from '@petshop/shared-types'
import { PortalError, readOwnStatement } from '@/lib/portal-api'

/**
 * A página seguinte do extrato.
 *
 * Server Action e não `fetch` do browser, pela mesma razão do resto do Portal: o token
 * do Clerk e o endereço do gateway não saem do servidor.
 */
export async function carregarLancamentos(
  page: number,
): Promise<({ ok: true } & PortalStatementResponse) | { ok: false; message: string }> {
  try {
    const resultado = await readOwnStatement({ page, limit: 10 })
    return { ok: true, ...resultado }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: 'Não foi possível carregar mais agora.' }
  }
}
