'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  AssignTaxiRideSchema,
  CancelTaxiRideSchema,
  FailTaxiRideSchema,
  TaxiStatusTransitionSchema,
  UpdateTaxiSettingsSchema,
  type AvailableTaxiDriver,
  type ClosedTaxiRide,
  type TaxiRideResponse,
  type TaxiSettings,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações do Taxi Dog.
 *
 * Rodam no servidor: o token do Clerk e a URL do gateway nunca chegam ao browser.
 * Cada ação devolve um resultado discriminado em vez de lançar — a tela precisa
 * mostrar o motivo no lugar certo, não uma página de erro.
 */

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /**
   * ERR_TAXI_006 e 007 carregam quem **pode** ir naquela janela. Negar sem oferecer
   * alternativa devolve a recepção ao WhatsApp, que é de onde este módulo veio para
   * tirá-la.
   */
  available?: AvailableTaxiDriver[]
  /** ERR_TAXI_007: a conta que motivou a recusa. */
  capacity?: number
  occupied?: number
  /** ERR_TAXI_004: a corrida que já existe naquela perna. */
  existingRide?: { id: string; status: string }
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const problem = error.problem as Record<string, unknown> | null
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(Array.isArray(problem?.available)
        ? { available: problem.available as AvailableTaxiDriver[] }
        : {}),
      ...(typeof problem?.capacity === 'number' ? { capacity: problem.capacity } : {}),
      ...(typeof problem?.occupied === 'number' ? { occupied: problem.occupied } : {}),
      ...(problem?.existingRide
        ? { existingRide: problem.existingRide as { id: string; status: string } }
        : {}),
    }
  }
  return {
    ok: false,
    message: 'Não foi possível concluir. Tente novamente.',
    fieldErrors: {},
  }
}

/** Revalida as duas telas: o painel e a rota mostram a mesma corrida. */
function revalidateTaxi(): void {
  revalidatePath('/taxi')
  revalidatePath('/taxi/rota')
}

export async function assignRideAction(
  rideId: string,
  input: unknown,
): Promise<ActionResult<TaxiRideResponse>> {
  const parsed = AssignTaxiRideSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: 'Escolha um motorista', fieldErrors: {} }
  }

  try {
    const data = await serverApi().assignTaxiRide(rideId, parsed.data)
    revalidateTaxi()
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function advanceRideAction(
  rideId: string,
  input: unknown,
): Promise<ActionResult<TaxiRideResponse>> {
  const parsed = TaxiStatusTransitionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: 'Transição inválida', fieldErrors: {} }
  }

  try {
    const data = await serverApi().advanceTaxiRide(rideId, parsed.data)
    revalidateTaxi()
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function failRideAction(
  rideId: string,
  input: unknown,
): Promise<ActionResult<ClosedTaxiRide>> {
  const parsed = FailTaxiRideSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: 'Informe o motivo da falha', fieldErrors: {} }
  }

  try {
    const data = await serverApi().failTaxiRide(rideId, parsed.data)
    revalidateTaxi()
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function cancelRideAction(
  rideId: string,
  input: unknown,
): Promise<ActionResult<ClosedTaxiRide>> {
  const parsed = CancelTaxiRideSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: 'Informe o motivo do cancelamento', fieldErrors: {} }
  }

  try {
    const data = await serverApi().cancelTaxiRide(rideId, parsed.data)
    revalidateTaxi()
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateTaxiSettingsAction(
  input: unknown,
): Promise<ActionResult<TaxiSettings>> {
  const parsed = UpdateTaxiSettingsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: 'Dados inválidos', fieldErrors: {} }
  }

  try {
    const data = await serverApi().updateTaxiSettings(parsed.data)
    revalidateTaxi()
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}
