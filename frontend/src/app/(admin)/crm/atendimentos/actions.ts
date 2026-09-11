'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type { AgentConversationDetail, AgentSettings } from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações da fila de atendimento (MOD-AI-06).
 *
 * Quatro, e todas partem de uma conversa que já existe: abrir, assumir, responder e
 * encerrar. **Nada aqui cria conversa** — a única porta de entrada é a mensagem do
 * cliente chegando pelo webhook da Evolution, e uma tela que pudesse iniciar conversa
 * estaria escrevendo para quem não pediu, que é exatamente o que o consentimento do
 * MOD-TUTOR governa.
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
 * A conversa inteira, para a janela.
 *
 * Carregada por ação e não junto da lista: o histórico de vinte conversas é muito texto
 * decifrado para desenhar uma fila em que a recepção vai abrir uma.
 */
export async function carregarConversaAction(
  id: string,
): Promise<ActionResult<AgentConversationDetail>> {
  try {
    return { ok: true, data: await serverApi().getAgentConversation(id) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function assumirConversaAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().assignAgentConversation(id)
    revalidatePath('/crm/atendimentos')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Responde e devolve a conversa já atualizada.
 *
 * A janela continua aberta depois do envio — é uma conversa, não um formulário que se
 * fecha —, então ela precisa da lista de turnos com a resposta dentro. Um `refresh()` da
 * página recarregaria a fila atrás do diálogo sem tocar no que está na frente dele.
 */
export async function responderConversaAction(
  id: string,
  texto: string,
): Promise<ActionResult<AgentConversationDetail>> {
  try {
    const api = serverApi()
    await api.replyAgentConversation(id, texto)
    const atualizada = await api.getAgentConversation(id)
    revalidatePath('/crm/atendimentos')
    return { ok: true, data: atualizada }
  } catch (error) {
    return toFailure(error)
  }
}

export async function encerrarConversaAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().closeAgentConversation(id)
    revalidatePath('/crm/atendimentos')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Liga, desliga e ajusta o atendimento automático (MOD-AI-07).
 *
 * Vale a partir da **próxima mensagem recebida**: o servidor derruba o cache de
 * configuração na gravação, e o turno que já estiver no ar termina com o que tinha.
 */
export async function salvarConfiguracaoAction(input: {
  enabled?: boolean
  opensAt?: string
  closesAt?: string
  monthlyCapCents?: number
}): Promise<ActionResult<AgentSettings>> {
  try {
    const atualizada = await serverApi().updateAgentSettings(input)
    revalidatePath('/crm/atendimentos')
    return { ok: true, data: atualizada }
  } catch (error) {
    return toFailure(error)
  }
}
