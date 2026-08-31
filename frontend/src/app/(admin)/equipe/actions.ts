'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  CreateInvitationSchema,
  type AssignableRoleKey,
  type InvitationResponse,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações da tela de equipe (MOD-IDENT-04 e MOD-IDENT-06).
 *
 * Mesma forma das ações de configurações: rodam no servidor, devolvem resultado
 * discriminado em vez de lançar, e a validação daqui existe só para o erro aparecer
 * no campo antes da viagem de rede — quem decide é o 422 do serviço.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; fieldErrors: Record<string, string> }

function toFailure(error: unknown): ActionResult<never> {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

function fromZod(error: z.ZodError): ActionResult<never> {
  const fieldErrors = Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
  )
  return { ok: false, message: error.issues[0]?.message ?? 'Dados inválidos', fieldErrors }
}

export async function inviteMemberAction(
  input: unknown,
): Promise<ActionResult<InvitationResponse>> {
  const parsed = CreateInvitationSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const invitation = await serverApi().createInvitation(parsed.data)
    revalidatePath('/equipe')
    return { ok: true, data: invitation }
  } catch (error) {
    return toFailure(error)
  }
}

export async function resendInvitationAction(
  id: string,
): Promise<ActionResult<InvitationResponse>> {
  try {
    const invitation = await serverApi().resendInvitation(id)
    revalidatePath('/equipe')
    return { ok: true, data: invitation }
  } catch (error) {
    return toFailure(error)
  }
}

export async function revokeInvitationAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().revokeInvitation(id)
    revalidatePath('/equipe')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

export async function changeRoleAction(
  membershipId: string,
  role: AssignableRoleKey,
): Promise<ActionResult<null>> {
  try {
    await serverApi().changeMemberRole(membershipId, role)
    // O papel muda o menu de quem foi alterado, e o painel mostra a equipe.
    revalidatePath('/equipe')
    revalidatePath('/dashboard')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
