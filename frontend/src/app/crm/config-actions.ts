'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type {
  AutomationResponse,
  CreateSuppressionInput,
  MessageChannel,
  MessagingSettingsResponse,
  ResolvedTemplate,
  TemplatePreview,
  UpdateAutomationInput,
  UpdateMessagingSettingsInput,
  UpsertMessageTemplateInput,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações de configuração do relacionamento (MOD-CRM-02, 03 e 04).
 *
 * Separadas de `actions.ts` porque o corte de permissão é outro: ali é `crm:read` e
 * `crm:send`, aqui é `crm:configure`. Quem lê o painel não muda o texto que sai para
 * a base inteira, e ter os dois no mesmo arquivo convidaria a confundi-los.
 *
 * Todas devolvem `fieldErrors`: o texto é o lugar do produto em que a validação fala
 * mais alto — escrever `{{tutor.nome_completo}}` num template que só conhece
 * `{{tutor.nome}}` precisa apontar para o campo, não para o topo da tela.
 */

export interface ConfigFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
}

export type ActionResult<T> = { ok: true; data: T } | ConfigFailure

function toFailure(error: unknown): ConfigFailure {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

// ─── Textos (MOD-CRM-02) ─────────────────────────────────────────────────────

export async function saveTemplateAction(
  key: string,
  channel: MessageChannel,
  input: UpsertMessageTemplateInput,
): Promise<ActionResult<ResolvedTemplate>> {
  try {
    const saved = await serverApi().saveMessageTemplate(key, channel, input)
    revalidatePath('/crm/textos')
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

export async function resetTemplateAction(
  key: string,
  channel: MessageChannel,
): Promise<ActionResult<ResolvedTemplate>> {
  try {
    const reset = await serverApi().resetMessageTemplate(key, channel)
    revalidatePath('/crm/textos')
    return { ok: true, data: reset }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Prévia com dados de exemplo. Não grava nem envia.
 *
 * Existe para que o admin veja a frase montada **antes** de salvar: a variável errada
 * aparece como buraco no texto, que é mais eloquente do que uma lista de nomes
 * válidos ao lado do campo.
 */
export async function previewTemplateAction(input: {
  templateKey: string
  channel: MessageChannel
  subject?: string
  body: string
}): Promise<ActionResult<TemplatePreview>> {
  try {
    return { ok: true, data: await serverApi().previewMessageTemplate(input) }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Motor (MOD-CRM-03) ──────────────────────────────────────────────────────

export async function updateMessagingSettingsAction(
  input: UpdateMessagingSettingsInput,
): Promise<ActionResult<MessagingSettingsResponse>> {
  try {
    const saved = await serverApi().updateMessagingSettings(input)
    revalidatePath('/crm/configuracoes')
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Automações ──────────────────────────────────────────────────────────────

export async function updateAutomationAction(
  key: string,
  input: UpdateAutomationInput,
): Promise<ActionResult<AutomationResponse>> {
  try {
    const saved = await serverApi().updateAutomation(key, input)
    revalidatePath('/crm/configuracoes')
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Supressões (MOD-CRM-04) ─────────────────────────────────────────────────

export async function createSuppressionAction(
  input: CreateSuppressionInput,
): Promise<ActionResult<null>> {
  try {
    await serverApi().createMessagingSuppression(input)
    revalidatePath('/crm/configuracoes')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deleteSuppressionAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deleteMessagingSuppression(id)
    revalidatePath('/crm/configuracoes')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
