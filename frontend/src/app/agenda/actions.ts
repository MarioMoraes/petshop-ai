'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import { randomUUID } from 'node:crypto'
import {
  CreateAppointmentSchema,
  CreateProfessionalSchema,
  CreateServiceSchema,
  ReplaceScheduleSchema,
  ReplaceServicePricingSchema,
  UpdateProfessionalSchema,
  UpdateServiceSchema,
  type AppointmentResponse,
  type ProfessionalResponse,
  type ServiceResponse,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações do catálogo da agenda (MOD-AGENDA, fatia 1).
 *
 * Rodam no servidor: o token do Clerk e a URL do gateway nunca chegam ao browser.
 * Cada ação devolve um resultado discriminado em vez de lançar — o formulário precisa
 * mostrar o erro no campo certo, não uma tela de erro.
 */

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /**
   * ERR_AGENDA_011 e 012 carregam o que bloqueou: a contagem de agendamentos do
   * serviço, ou a lista dos que caem no profissional. A tela precisa mostrar o
   * motivo — "não dá" sem dizer por quê vira chamado de suporte.
   */
  futureAppointments?: number
  appointments?: { id: string; startsAt: string; petName: string }[]
  /** ERR_AGENDA_009: alerta clínico crítico a reconhecer antes de prosseguir. */
  alerts?: { id: string; label: string; severity: string }[]
  /** ERR_AGENDA_008: débito acima do limite; só um admin libera. */
  requiresOverride?: boolean
  balanceCents?: number
  /** ERR_AGENDA_004 e 005: os horários livres mais próximos do que foi pedido. */
  suggestions?: { startsAt: string; endsAt: string }[]
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const problem = error.problem as Record<string, unknown> | null
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(typeof problem?.futureAppointments === 'number'
        ? { futureAppointments: problem.futureAppointments }
        : {}),
      ...(Array.isArray(problem?.appointments)
        ? { appointments: problem.appointments as ActionFailure['appointments'] }
        : {}),
      ...(Array.isArray(problem?.alerts)
        ? { alerts: problem.alerts as ActionFailure['alerts'] }
        : {}),
      ...(problem?.requiresOverride === true ? { requiresOverride: true } : {}),
      ...(typeof problem?.balanceCents === 'number'
        ? { balanceCents: problem.balanceCents }
        : {}),
      ...(Array.isArray(problem?.suggestions)
        ? { suggestions: problem.suggestions as ActionFailure['suggestions'] }
        : {}),
    }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

function fromZod(error: z.ZodError): ActionFailure {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = issue.path.join('.')
    fieldErrors[field] ??= issue.message
  }
  return {
    ok: false,
    message: error.issues[0]?.message ?? 'Dados inválidos',
    fieldErrors,
  }
}

function revalidateCatalog(): void {
  revalidatePath('/agenda/servicos')
  revalidatePath('/agenda/profissionais')
}

// ─── Serviços ────────────────────────────────────────────────────────────────

export async function createServiceAction(input: unknown): Promise<ActionResult<ServiceResponse>> {
  const parsed = CreateServiceSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const service = await serverApi().createService(parsed.data)
    revalidateCatalog()
    return { ok: true, data: service }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateServiceAction(
  id: string,
  patch: unknown,
): Promise<ActionResult<ServiceResponse>> {
  const parsed = UpdateServiceSchema.safeParse(patch)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const service = await serverApi().updateService(id, parsed.data)
    revalidateCatalog()
    return { ok: true, data: service }
  } catch (error) {
    return toFailure(error)
  }
}

/** A tabela de preços é substituída inteira — é `PUT`, não remendo. */
export async function replacePricingAction(
  id: string,
  input: unknown,
): Promise<ActionResult<ServiceResponse>> {
  const parsed = ReplaceServicePricingSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const service = await serverApi().replaceServicePricing(id, parsed.data.pricing)
    revalidateCatalog()
    return { ok: true, data: service }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deleteServiceAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deleteService(id)
    revalidateCatalog()
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Profissionais ───────────────────────────────────────────────────────────

export async function createProfessionalAction(
  input: unknown,
): Promise<ActionResult<ProfessionalResponse>> {
  const parsed = CreateProfessionalSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const professional = await serverApi().createProfessional(parsed.data)
    revalidateCatalog()
    return { ok: true, data: professional }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateProfessionalAction(
  id: string,
  patch: unknown,
): Promise<ActionResult<ProfessionalResponse>> {
  const parsed = UpdateProfessionalSchema.safeParse(patch)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const professional = await serverApi().updateProfessional(id, parsed.data)
    revalidateCatalog()
    return { ok: true, data: professional }
  } catch (error) {
    return toFailure(error)
  }
}

/** Devolve `warnings[]` quando a jornada passa do horário do tenant (AC-03). */
export async function replaceScheduleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<ProfessionalResponse & { warnings: string[] }>> {
  const parsed = ReplaceScheduleSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().replaceProfessionalSchedule(id, parsed.data.windows)
    revalidateCatalog()
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Agendamentos ────────────────────────────────────────────────────────────

export async function checkInAction(id: string): Promise<ActionResult<AppointmentResponse>> {
  try {
    const appointment = await serverApi().checkInAppointment(id)
    revalidatePath('/agenda/dia')
    return { ok: true, data: appointment }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * A chave de idempotência nasce **aqui**, no servidor, e não no cliente: o duplo
 * clique no botão de concluir chega como duas requisições, e é esta chave que impede
 * o débito de ser lançado duas vezes do lado do MOD-LEDGER.
 */
export async function checkOutAction(
  id: string,
  input: { weightKg?: number; notes?: string; extraItems?: { serviceId: string }[] },
): Promise<ActionResult<AppointmentResponse>> {
  try {
    const appointment = await serverApi().checkOutAppointment(id, {
      idempotencyKey: randomUUID(),
      ...input,
    })
    revalidatePath('/agenda/dia')
    return { ok: true, data: appointment }
  } catch (error) {
    return toFailure(error)
  }
}

export async function cancelAppointmentAction(
  id: string,
  input: { reason?: string; waiveFee?: boolean },
): Promise<ActionResult<AppointmentResponse>> {
  try {
    const appointment = await serverApi().cancelAppointment(id, input)
    revalidatePath('/agenda/dia')
    return { ok: true, data: appointment }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Busca de pets para o seletor do agendamento.
 *
 * Server action e não chamada direta do cliente: o token do Clerk e a URL do gateway
 * não podem ir para o browser. Devolve o mínimo que o seletor precisa — nome, tutor e
 * porte —, e não o cadastro inteiro.
 */
export async function searchPetsAction(query: string): Promise<
  ActionResult<{ id: string; name: string; tutorName: string; sizeLabel: string }[]>
> {
  try {
    const result = await serverApi().listPets({ q: query, limit: 8 })
    return {
      ok: true,
      data: result.data.map((pet) => ({
        id: pet.id,
        name: pet.name,
        // O responsável principal é quem responde pelo agendamento; RN-16 admite
        // cinco "Mel" no mesmo tenant, e é o nome do tutor que desfaz o empate.
        tutorName:
          pet.tutors.find((link) => link.role === 'PRIMARY')?.fullName ?? 'Sem responsável',
        sizeLabel: pet.size.label,
      })),
    }
  } catch (error) {
    return toFailure(error)
  }
}

/** Horários livres já com a duração e o preço calculados para **este** pet. */
export async function availabilityAction(query: {
  serviceId: string
  petId: string
  professionalId?: string
  from: string
  to: string
}): Promise<
  ActionResult<{
    slots: {
      professionalId: string
      professionalName: string
      startsAt: string
      endsAt: string
      durationMin: number
      priceCents: number
    }[]
    nextAvailable: string | null
    durationMin: number
    priceCents: number
  }>
> {
  try {
    return { ok: true, data: await serverApi().getAvailability(query) }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Cria o agendamento.
 *
 * Os gates do MOD-AGENDA-10 voltam como falha estruturada, não como exceção: o alerta
 * clínico crítico (`alerts`) e o débito acima do limite (`requiresOverride`) são
 * respostas legítimas que a tela precisa **mostrar** para o atendente decidir, e não
 * erros a esconder. Reenviar com `acknowledgedAlerts` ou `override` conclui.
 */
export async function createAppointmentAction(
  input: unknown,
): Promise<ActionResult<AppointmentResponse>> {
  const parsed = CreateAppointmentSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const appointment = await serverApi().createAppointment(parsed.data)
    revalidatePath('/agenda/dia')
    return { ok: true, data: appointment }
  } catch (error) {
    return toFailure(error)
  }
}
