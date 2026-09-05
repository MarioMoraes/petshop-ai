'use server'

import { revalidatePath } from 'next/cache'
import type {
  PortalAvailabilityResponse,
  PortalBookingServicesResponse,
  PortalTaxiOffer,
} from '@petshop/shared-types'
import {
  PortalError,
  createBooking,
  readAvailability,
  readBookableServices,
  readTaxiOffer,
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
  /**
   * Os horários do mesmo dia em que o leva-e-traz ainda cabe (AC-04 de MOD-PORTAL-07).
   *
   * Chega no corpo do 409 de van cheia, e é o que transforma a recusa em escolha: sem
   * eles o tutor fica sabendo que não pode e não fica sabendo quando poderia.
   */
  alternativeStartsAt?: string[]
}

function toFailure(error: unknown): ActionFailure {
  if (error instanceof PortalError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.alternativeStartsAt ? { alternativeStartsAt: error.alternativeStartsAt } : {}),
    }
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

/**
 * A oferta de leva-e-traz (MOD-PORTAL-07).
 *
 * Carregada junto dos serviços e não a cada mudança de escolha: o preço é do CEP do
 * endereço primário do tutor, e nem o pet nem o horário o mudam.
 */
export async function carregarTaxi(): Promise<
  ({ ok: true } & PortalTaxiOffer) | ActionFailure
> {
  try {
    return { ok: true, ...(await readTaxiOffer()) }
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
  taxi?: { pickup: boolean; dropoff: boolean }
}): Promise<({ ok: true } & CreatedBookingResponse) | ActionFailure> {
  try {
    const booking = await createBooking(input)
    // A lista de agendamentos e a ficha do pet mostram o mesmo compromisso; sem isto o
    // tutor voltaria para "Meus agendamentos" e não veria o que acabou de marcar.
    revalidatePath('/portal/agendamentos')
    revalidatePath('/portal/pets')
    revalidatePath('/portal/inicio')
    // O leva-e-traz vira item do agendamento e entra na conta do tutor (RN-05 do
    // MOD-TAXI); sem isto o extrato mostraria o banho e não o transporte.
    revalidatePath('/portal/financeiro')
    return { ok: true, ...booking }
  } catch (error) {
    return toFailure(error)
  }
}
