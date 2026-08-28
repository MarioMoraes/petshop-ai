'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  AssignTaxiRideSchema,
  CancelTaxiRideSchema,
  CreateTaxiRidesSchema,
  FailTaxiRideSchema,
  TaxiStatusTransitionSchema,
  TaxiZoneSchema,
  UpdateTaxiSettingsSchema,
  UpdateTaxiZoneSchema,
  type AddressResponse,
  type AvailableTaxiDriver,
  type ClosedTaxiRide,
  type TaxiQuote,
  type TaxiRideResponse,
  type TaxiSettings,
  type TaxiZoneResponse,
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

/**
 * Criar a corrida a partir de um agendamento (MOD-TAXI-01).
 *
 * Mora aqui, e não em `agenda/actions.ts`, porque quem chama é a Agenda do Dia mas
 * quem responde pelo resultado é o Taxi Dog: `toFailure` já sabe desdobrar o
 * `available` de van cheia e o `existingRide` de perna repetida, e os dois precisam
 * chegar inteiros na tela que pediu a corrida.
 *
 * Revalida também `/agenda/dia`: o item de taxi entra em `appointments.total_cents`,
 * então o cartão do atendimento fica desatualizado no instante seguinte à criação.
 */
export async function createRidesAction(
  input: unknown,
): Promise<ActionResult<TaxiRideResponse[]>> {
  const parsed = CreateTaxiRidesSchema.safeParse(input)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      if (path && !fieldErrors[path]) fieldErrors[path] = issue.message
    }
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
      fieldErrors,
    }
  }

  try {
    const { items } = await serverApi().createTaxiRides(parsed.data)
    revalidateTaxi()
    revalidatePath('/agenda/dia')
    return { ok: true, data: items }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * "Quanto custa buscar aqui?" — consulta pura, sem criar corrida (MOD-TAXI-06).
 *
 * Devolve `null` em qualquer falha: o preço é confirmação, não pré-requisito. Se a
 * cotação não vier, a recepção ainda pode criar a corrida e o servidor calcula o
 * mesmo valor na hora.
 */
export async function taxiQuoteAction(zipCode: string): Promise<TaxiQuote | null> {
  const digits = zipCode.replace(/\D/g, '')
  if (digits.length !== 8) return null

  try {
    return await serverApi().getTaxiQuote(digits)
  } catch {
    return null
  }
}

/**
 * O endereço que a corrida vai herdar (AC-01 de MOD-TAXI-02).
 *
 * A tela mostra antes de criar porque o motorista vai para onde este endereço diz —
 * e a recepção é a última pessoa capaz de perceber que o tutor se mudou.
 */
export async function tutorPrimaryAddressAction(
  tutorId: string,
): Promise<AddressResponse | null> {
  try {
    const addresses = await serverApi().listAddresses(tutorId)
    return addresses.find((address) => address.isPrimary) ?? null
  } catch {
    return null
  }
}

// ─── Zonas de preço (MOD-TAXI-06) ────────────────────────────────────────────
//
// Revalidam `/agenda/dia` junto: é lá que a cotação da corrida aparece antes de o
// atendente confirmar, e uma zona nova muda o preço que aquela tela mostra.

function revalidateZones(): void {
  revalidatePath('/taxi/configuracoes')
  revalidatePath('/agenda/dia')
}

export async function createZoneAction(input: unknown): Promise<ActionResult<TaxiZoneResponse>> {
  const parsed = TaxiZoneSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
      ),
    }
  }

  try {
    const data = await serverApi().createTaxiZone(parsed.data)
    revalidateZones()
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateZoneAction(
  zoneId: string,
  input: unknown,
): Promise<ActionResult<TaxiZoneResponse>> {
  const parsed = UpdateTaxiZoneSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
      ),
    }
  }

  try {
    const data = await serverApi().updateTaxiZone(zoneId, parsed.data)
    revalidateZones()
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Excluir só quando ninguém depende. Zona com corrida devolve ERR_TAXI_013, e a saída
 * é desativar: o preço da corrida ficou congelado nela (RN-07), e apagar a linha faria
 * o histórico perder a resposta para "por que esta corrida custou R$ 30?".
 */
export async function deleteZoneAction(zoneId: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deleteTaxiZone(zoneId)
    revalidateZones()
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
