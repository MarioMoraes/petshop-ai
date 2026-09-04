'use server'

import { revalidatePath } from 'next/cache'
import type { PortalAppointmentDetail } from '@petshop/shared-types'
import {
  PortalError,
  cancelOwnAppointment,
  readOwnAppointment,
  rescheduleOwnAppointment,
} from '@/lib/portal-api'

/**
 * Cancelar e remarcar (MOD-PORTAL-06).
 *
 * `cancelar` devolve o pedido de confirmação como **resultado**, e não como erro de
 * tela: o `ERR_PORTAL_011` do servidor não é uma falha, é a pergunta "cancelar agora
 * custa R$ X, tem certeza?". Tratá-lo como erro genérico faria a tela dizer "não deu"
 * para o que é, na verdade, uma decisão a tomar.
 */

export interface ActionFailure {
  ok: false
  message: string
}

/** O servidor quer que o tutor veja o preço antes de decidir (AC-03). */
export interface FeeConfirmation {
  ok: false
  needsFeeConfirmation: true
  message: string
}

export async function detalharAgendamento(
  id: string,
): Promise<({ ok: true } & PortalAppointmentDetail) | ActionFailure> {
  try {
    return { ok: true, ...(await readOwnAppointment(id)) }
  } catch (error) {
    return { ok: false, message: mensagem(error) }
  }
}

export async function cancelar(
  id: string,
  acknowledgeFee: boolean,
): Promise<{ ok: true } | FeeConfirmation | ActionFailure> {
  try {
    await cancelOwnAppointment(id, { acknowledgeFee })
    revalidar(id)
    return { ok: true }
  } catch (error) {
    if (error instanceof PortalError && error.code === 'ERR_PORTAL_011') {
      return { ok: false, needsFeeConfirmation: true, message: error.message }
    }
    return { ok: false, message: mensagem(error) }
  }
}

export async function remarcar(
  id: string,
  input: { startsAt: string; professionalId: string },
): Promise<{ ok: true; id: string } | ActionFailure> {
  try {
    const novo = await rescheduleOwnAppointment(id, input)
    revalidar(id)
    return { ok: true, id: novo.id }
  } catch (error) {
    return { ok: false, message: mensagem(error) }
  }
}

function revalidar(id: string): void {
  revalidatePath('/portal/agendamentos')
  revalidatePath(`/portal/agendamentos/${id}`)
  // O cartão do pet mostra o próximo agendamento; sem isto ele continuaria anunciando
  // um horário que acabou de deixar de existir.
  revalidatePath('/portal/pets')
  revalidatePath('/portal/inicio')
}

function mensagem(error: unknown): string {
  if (error instanceof PortalError) return error.message
  return 'Não foi possível concluir agora. Tente de novo.'
}
