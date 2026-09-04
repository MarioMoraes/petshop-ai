'use server'

import { revalidatePath } from 'next/cache'
import type {
  PortalAvailabilityResponse,
  PortalBookingServicesResponse,
} from '@petshop/shared-types'
import {
  PortalError,
  createBooking,
  readAvailability,
  readBookableServices,
  type CreatedBookingResponse,
} from '@/lib/portal-api'

/**
 * As três perguntas do agendamento, do lado do servidor (MOD-PORTAL-05).
 *
 * Server Action e não `fetch` do browser, como em todo o Portal: o token do Clerk e o
 * endereço do gateway não saem do servidor.
 *
 * Todas devolvem resultado discriminado em vez de lançar. A tela do agendamento erra o
 * tempo todo por motivos legítimos — o horário que acabou de ser tomado, a conta em
 * aberto, a antecedência mínima — e cada um desses erros tem uma frase própria a
 * mostrar **dentro** da tela. Uma exceção derrubaria o wizard inteiro e apagaria o que
 * o tutor já tinha escolhido.
 */

export interface ActionFailure {
  ok: false
  code: string
  message: string
  /** As alternativas que o domínio mandou junto do 409 de conflito. */
  suggestions?: { startsAt: string }[]
}

function toFailure(error: unknown): ActionFailure {
  if (error instanceof PortalError) {
    return { ok: false, code: error.code, message: error.message }
  }
  return {
    ok: false,
    code: 'ERR_PORTAL_010',
    message: 'Não foi possível concluir agora. Tente de novo.',
  }
}

export async function carregarServicos(
  petId: string,
): Promise<({ ok: true } & PortalBookingServicesResponse) | ActionFailure> {
  try {
    return { ok: true, ...(await readBookableServices(petId)) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function carregarHorarios(query: {
  petId: string
  serviceIds: string[]
  date: string
}): Promise<({ ok: true } & PortalAvailabilityResponse) | ActionFailure> {
  try {
    return { ok: true, ...(await readAvailability(query)) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function confirmarAgendamento(input: {
  petId: string
  serviceIds: string[]
  startsAt: string
  professionalId: string
  acknowledgedAlerts?: boolean
}): Promise<({ ok: true } & CreatedBookingResponse) | ActionFailure> {
  try {
    const booking = await createBooking(input)
    // A lista de agendamentos e a ficha do pet mostram o mesmo compromisso; sem isto o
    // tutor voltaria para "Meus agendamentos" e não veria o que acabou de marcar.
    revalidatePath('/portal/agendamentos')
    revalidatePath('/portal/pets')
    revalidatePath('/portal/inicio')
    return { ok: true, ...booking }
  } catch (error) {
    return toFailure(error)
  }
}
