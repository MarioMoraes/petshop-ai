'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type { PaginatedMessages } from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações do painel de entregas (MOD-CRM-11).
 *
 * São só três, e todas partem de uma mensagem que já existe: reenviar, cancelar e
 * paginar. **Nada aqui cria mensagem** — a única porta de entrada do envio é o
 * `POST /v1/messages`, que o crm-automation-service usa, e a campanha manual que o
 * usaria pela tela é a fatia 3.
 *
 * O reenvio revalida consentimento e supressão no serviço, não aqui: se a checagem
 * morasse na tela, o mesmo botão numa segunda tela burlaria o opt-out.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string }

function toFailure(error: unknown): { ok: false; message: string } {
  if (error instanceof ApiError) return { ok: false, message: error.message }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
  }
}

/**
 * O painel guarda os filtros na URL, então o `revalidatePath` do próprio `/crm` é o
 * que faz a linha reaparecer com o estado novo. A ficha do tutor mostra as mesmas
 * mensagens e é revalidada por `router.refresh()` de lá — ela é `force-dynamic`.
 */
export async function retryMessageAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().retryMessage(id)
    revalidatePath('/crm')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

export async function cancelMessageAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().cancelMessage(id)
    revalidatePath('/crm')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Página seguinte do histórico de um tutor.
 *
 * Existe porque a ficha do tutor pagina **dentro de uma aba**: mandar a página para a
 * URL, como o painel faz, devolveria o atendente à aba "Dados" a cada clique.
 */
export async function loadTutorMessagesAction(
  tutorId: string,
  page: number,
): Promise<ActionResult<PaginatedMessages>> {
  try {
    return { ok: true, data: await serverApi().listTutorMessages(tutorId, { page, limit: 20 }) }
  } catch (error) {
    return toFailure(error)
  }
}
