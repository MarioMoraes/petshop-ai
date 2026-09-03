'use server'

import { revalidatePath } from 'next/cache'
import type { PortalTimelineResponse, UpdateOwnPetInput } from '@petshop/shared-types'
import { PortalError, readOwnPetTimeline, updateOwnPet } from '@/lib/portal-api'

/**
 * A edição da ficha pelo tutor (MOD-PORTAL-03).
 *
 * Devolve resultado discriminado em vez de lançar: o diálogo precisa mostrar o erro
 * dentro dele, e uma exceção aqui derrubaria a página inteira por causa de um campo.
 *
 * A mensagem do 422 vem do serviço e não é reescrita aqui. Os textos de `ERR_PORTAL_*`
 * já foram escritos para o cliente final — "peso e porte são atualizados pelo petshop" —,
 * e uma segunda cópia envelheceria sozinha.
 */

export interface ActionFailure {
  ok: false
  message: string
}

export async function salvarPet(
  petId: string,
  input: UpdateOwnPetInput,
): Promise<{ ok: true } | ActionFailure> {
  try {
    await updateOwnPet(petId, input)
    // A ficha e a lista mostram os mesmos campos; recarregar só a ficha deixaria o nome
    // antigo no cartão de "Meus pets" até a próxima navegação dura.
    revalidatePath('/portal/pets')
    revalidatePath(`/portal/pets/${petId}`)
    return { ok: true }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: 'Não foi possível salvar agora. Tente de novo.' }
  }
}

/**
 * A página seguinte do histórico.
 *
 * Server Action e não `fetch` do browser pela mesma razão de todo o resto do Portal: o
 * token do Clerk e o endereço do gateway não saem do servidor.
 */
export async function carregarMais(
  petId: string,
  cursor: string,
): Promise<({ ok: true } & PortalTimelineResponse) | ActionFailure> {
  try {
    const resultado = await readOwnPetTimeline(petId, { cursor, limit: 10 })
    return { ok: true, ...resultado }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: 'Não foi possível carregar mais agora.' }
  }
}
