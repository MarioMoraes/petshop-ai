'use server'

import type {
  PortalMessagesResponse,
  PortalPreferencesResponse,
  UpdatePortalPreferenceInput,
} from '@petshop/shared-types'
import { PortalError, readOwnMessages, updateOwnPreference } from '@/lib/portal-api'

/**
 * As ações da Central de Comunicação.
 *
 * Server Actions e não `fetch` do navegador, pela mesma razão do resto do Portal: o
 * token do Clerk e o endereço do gateway não saem do servidor.
 */

export async function carregarMensagens(
  page: number,
): Promise<({ ok: true } & PortalMessagesResponse) | { ok: false; message: string }> {
  try {
    const resultado = await readOwnMessages({ page, limit: 10 })
    return { ok: true, ...resultado }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: 'Não foi possível carregar mais agora.' }
  }
}

/**
 * Liga ou desliga um canal de marketing.
 *
 * A resposta traz o estado **relido do servidor**, e é ele que o interruptor passa a
 * mostrar. A tela não assume que o clique deu certo: uma preferência que parece salva e
 * não está é o defeito mais caro desta tela — o tutor volta a receber o que desligou e
 * conclui que ninguém o ouviu.
 */
export async function salvarPreferencia(
  input: UpdatePortalPreferenceInput,
): Promise<({ ok: true } & PortalPreferencesResponse) | { ok: false; message: string }> {
  try {
    const resultado = await updateOwnPreference(input)
    return { ok: true, ...resultado }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: 'Não foi possível salvar agora. Tente novamente.' }
  }
}
