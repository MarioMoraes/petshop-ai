'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  BrandingSchema,
  BusinessHoursSchema,
  CreateTenantSchema,
  PlanSchema,
  type BusinessHours,
  type SlugAvailability,
  type TenantResponse,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações do wizard.
 *
 * Rodam no servidor: o token do Clerk e a URL do gateway nunca chegam ao browser.
 * Cada ação devolve um resultado discriminado em vez de lançar — o formulário
 * precisa mostrar o erro do campo, não uma tela de erro.
 */

export type ActionResult<T = TenantResponse> =
  | { ok: true; data: T }
  | { ok: false; message: string; fieldErrors: Record<string, string> }

function toFailure(error: unknown): ActionResult<never> {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  // Gateway fora do ar, DNS, timeout: o usuário não tem o que fazer com o detalhe.
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
  return {
    ok: false,
    message: error.issues[0]?.message ?? 'Dados inválidos',
    fieldErrors,
  }
}

// ─── Etapa 1 — dados do petshop ──────────────────────────────────────────────

export async function checkSlugAction(slug: string): Promise<SlugAvailability | null> {
  if (!slug || slug.length < 3) return null
  try {
    return await serverApi().checkSlug(slug)
  } catch {
    // Feedback de disponibilidade é conveniência: falhar aqui não pode travar o
    // formulário, já que o 409 do servidor é a checagem que vale.
    return null
  }
}

export async function createTenantAction(input: unknown): Promise<ActionResult> {
  const parsed = CreateTenantSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tenant = await serverApi().createTenant(parsed.data)
    revalidatePath('/onboarding')
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

const Step1Schema = z.object({
  name: z.string().min(2, 'Informe o nome do petshop').max(120),
  legalName: z.string().max(160).optional(),
})

export async function saveStep1Action(input: unknown): Promise<ActionResult> {
  const parsed = Step1Schema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tenant = await serverApi().advanceOnboarding({
      step: 1,
      data: { name: parsed.data.name, legalName: parsed.data.legalName ?? null },
    })
    revalidatePath('/onboarding')
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Etapa 2 — plano ─────────────────────────────────────────────────────────

export async function saveStep2Action(plan: unknown): Promise<ActionResult> {
  const parsed = PlanSchema.safeParse(plan)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tenant = await serverApi().advanceOnboarding({ step: 2, data: { plan: parsed.data } })
    revalidatePath('/onboarding')
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Etapa 3 — configuração operacional ──────────────────────────────────────

const Step3Schema = z.object({
  timezone: z.string().min(1),
  businessHours: BusinessHoursSchema,
  cancellationWindowHours: z.number().int().min(0).max(72),
  minBookingNoticeHours: z.number().int().min(0).max(168),
  noShowFeePercent: z.number().int().min(0).max(100),
  /**
   * Quem atende. O catálogo de serviços já veio semeado no provisionamento; nome de
   * gente é o que o sistema não consegue adivinhar, e sem pelo menos um profissional
   * a agenda não existe. Lista vazia passa: dá para cadastrar depois em
   * `/profissionais`.
   */
  professionals: z
    .array(
      z.object({
        displayName: z.string().trim().min(2).max(60),
        roleKey: z.enum(['GROOMER', 'BATHER', 'VET', 'DRIVER']),
        maxConcurrentPets: z.number().int().min(1).max(20),
      }),
    )
    .max(30)
    .default([]),
})

export async function saveStep3Action(input: unknown): Promise<ActionResult> {
  const parsed = Step3Schema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tenant = await serverApi().advanceOnboarding({ step: 3, data: parsed.data })
    revalidatePath('/onboarding')
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Etapa 4 — identidade visual e conclusão ─────────────────────────────────

export async function finishOnboardingAction(branding: unknown): Promise<ActionResult> {
  const parsed = BrandingSchema.safeParse(branding)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tenant = await serverApi().advanceOnboarding({
      step: 4,
      data: { branding: parsed.data },
    })
    revalidatePath('/onboarding')
    revalidatePath('/dashboard')
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

export async function skipBrandingAction(): Promise<ActionResult> {
  try {
    const tenant = await serverApi().advanceOnboarding({ step: 4, skipped: true })
    revalidatePath('/onboarding')
    revalidatePath('/dashboard')
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

export type { BusinessHours }
