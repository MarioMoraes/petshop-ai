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

/**
 * Um agendamento que impede a remoção (RN-07 de MOD-IDENT).
 *
 * O 409 traz a lista no corpo porque a decisão é de quem está na tela: reatribuir a
 * outro profissional ou cancelar. O diálogo a exibe; o servidor não decide por ela.
 */
export interface BlockingAppointment {
  id: string
  startsAt: string
  petName: string
  serviceLabel: string
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      message: string
      fieldErrors: Record<string, string>
      appointments?: BlockingAppointment[]
    }

function toFailure(error: unknown): ActionResult<never> {
  if (error instanceof ApiError) {
    const extra = error.problem?.appointments
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(Array.isArray(extra) ? { appointments: extra as BlockingAppointment[] } : {}),
    }
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

/**
 * Suspender e reativar o acesso (MOD-IDENT-05).
 *
 * `/dashboard` também é revalidado: quem foi suspenso perde o menu inteiro, e o
 * contador de equipe do início conta quem tem acesso.
 */
export async function changeMemberStatusAction(
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<ActionResult<null>> {
  try {
    await serverApi().changeMemberStatus(membershipId, status)
    revalidatePath('/equipe')
    revalidatePath('/dashboard')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Remover da equipe (MOD-IDENT-05).
 *
 * O 409 da agenda futura chega aqui como falha **com lista**: é o único caminho da tela
 * em que a mensagem sozinha não basta para agir.
 */
export async function removeMemberAction(membershipId: string): Promise<ActionResult<null>> {
  try {
    await serverApi().removeMember(membershipId)
    revalidatePath('/equipe')
    revalidatePath('/dashboard')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
