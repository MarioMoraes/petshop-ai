'use server'

import { ApiError } from '@petshop/api-client'
import type { AcceptInvitationResult } from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * O aceite, do lado do servidor.
 *
 * Não redireciona aqui: quem acabou de aceitar tem vínculo no banco e ainda não tem
 * `org_id` na sessão do Clerk. Mandar para `/dashboard` agora devolveria alguém sem
 * tenant resolvido — e o `/` o jogaria no wizard de criar um petshop novo, que é o
 * oposto do que a pessoa fez. Quem termina o trabalho é o `EnsureActiveOrganization`,
 * no cliente, depois de ativar a Organization.
 */

export type AcceptResult =
  | { ok: true; data: AcceptInvitationResult }
  | { ok: false; message: string }

export async function acceptInvitationAction(token: string): Promise<AcceptResult> {
  try {
    return { ok: true, data: await serverApi().acceptInvitation(token) }
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message }
    return {
      ok: false,
      message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    }
  }
}
