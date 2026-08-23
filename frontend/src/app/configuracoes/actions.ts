'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  BrandingSchema,
  BusinessHoursSchema,
  UpdateTenantSchema,
  UpdateTenantSettingsSchema,
  type TenantResponse,
  type TenantSettings,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações da tela de configurações (MOD-IDENT-08, parcial).
 *
 * Rodam no servidor: o token do Clerk e a URL do gateway nunca chegam ao browser.
 * Cada ação devolve um resultado discriminado em vez de lançar — o formulário precisa
 * mostrar o erro no campo certo, não uma tela de erro.
 *
 * A validação é feita aqui **e** no serviço. A daqui existe para o erro aparecer no
 * campo antes da viagem de rede; quem decide é o 422 do backend.
 */

export type ActionResult<T> =
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
  return { ok: false, message: error.issues[0]?.message ?? 'Dados inválidos', fieldErrors }
}

/**
 * `/dashboard` mostra o nome do estabelecimento e saúda pelo fuso configurado; as
 * telas de tutores herdam o cabeçalho. Revalidar as três evita o incômodo clássico de
 * salvar e continuar vendo o valor antigo na navegação.
 */
function revalidateAll(): void {
  revalidatePath('/configuracoes')
  revalidatePath('/dashboard')
  revalidatePath('/tutores')
}

// ─── Dados do estabelecimento ────────────────────────────────────────────────

export async function saveIdentityAction(input: unknown): Promise<ActionResult<TenantResponse>> {
  const parsed = UpdateTenantSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tenant = await serverApi().updateTenant(parsed.data)
    revalidateAll()
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Horário de funcionamento ────────────────────────────────────────────────

const HoursPatchSchema = z.object({
  timezone: z.string().min(1),
  businessHours: BusinessHoursSchema,
})

export async function saveHoursAction(input: unknown): Promise<ActionResult<TenantSettings>> {
  const parsed = HoursPatchSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const settings = await serverApi().updateSettings(parsed.data)
    revalidateAll()
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Políticas de agenda ─────────────────────────────────────────────────────

const PoliciesPatchSchema = UpdateTenantSettingsSchema.pick({
  cancellationWindowHours: true,
  minBookingNoticeHours: true,
  noShowFeePercent: true,
  allowOverbooking: true,
  onlineBookingEnabled: true,
})

export async function savePoliciesAction(input: unknown): Promise<ActionResult<TenantSettings>> {
  const parsed = PoliciesPatchSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const settings = await serverApi().updateSettings(parsed.data)
    revalidateAll()
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Identidade visual ───────────────────────────────────────────────────────

export async function saveBrandingAction(input: unknown): Promise<ActionResult<TenantSettings>> {
  const parsed = BrandingSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const settings = await serverApi().updateSettings({ branding: parsed.data })
    revalidateAll()
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}
