'use server'

import { revalidatePath } from 'next/cache'
import type { TermKind } from '@petshop/shared-types'
import { PortalError, acceptOwnTerm } from '@/lib/portal-api'

/**
 * O aceite do termo, pelo Portal (AC-02 de MOD-DOC-07).
 *
 * Server Action e não `fetch` do browser, pela mesma razão do resto do Portal: o token do
 * Clerk e o endereço do gateway não saem do servidor.
 *
 * **O IP e o user-agent que viram prova são os do tutor**, e chegam ao tutor-service pelos
 * headers que o BFF repassa. É por isso que o aceite não é gravado aqui: a linha
 * registraria o endereço do servidor do Next, uma prova que aponta para nós mesmos.
 */
export async function aceitarTermo(
  kind: TermKind,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await acceptOwnTerm(kind)
    revalidatePath('/portal/documentos')
    return { ok: true }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: 'Não foi possível registrar o aceite agora.' }
  }
}
