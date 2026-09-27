'use server'

import type { PortalStatementResponse } from '@petshop/shared-types'
import { PortalError, payOwnBalance, readOwnStatement } from '@/lib/portal-api'

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

/**
 * Pagar agora: o link da cobrança online, pelo Asaas do petshop.
 *
 * O valor é o saldo devedor, decidido no servidor — a ação não recebe nada. A tela abre o
 * link devolvido; tocar de novo devolve o mesmo.
 */
export async function abrirPagamento(): Promise<
  { ok: true; url: string } | { ok: false; message: string }
> {
  try {
    const { url } = await payOwnBalance()
    return { ok: true, url }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: 'Não foi possível abrir o pagamento agora. Tente de novo.' }
  }
}
