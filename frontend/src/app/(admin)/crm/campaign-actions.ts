'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type {
  CampaignPreview,
  CampaignSummary,
  CampaignTargetRow,
  CreateCampaignInput,
  UpdateCampaignInput,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações das campanhas (MOD-CRM-12).
 *
 * Separadas de `config-actions.ts` porque o corte de permissão é outro: lá é
 * `crm:configure`, aqui é `crm:send` — e a diferença entre as duas é a diferença entre
 * mudar um texto e mandá-lo para a base inteira.
 *
 * `runCampaignAction` devolve o erro **inteiro**, com os dois números do 409: a tela
 * precisa dizer "você viu 340, agora são 352" para a pessoa entender por que o disparo
 * parou, e um "contagem divergente" seco a faria clicar de novo.
 */

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /** Do 409 da confirmação de contagem, quando é esse o caso. */
  actualTargets?: number
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const actual = (error.problem as { actualTargets?: unknown } | undefined)?.actualTargets
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(typeof actual === 'number' ? { actualTargets: actual } : {}),
    }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

export async function createCampaignAction(
  input: CreateCampaignInput,
): Promise<ActionResult<CampaignSummary>> {
  try {
    const created = await serverApi().createCampaign(input)
    revalidatePath('/crm/campanhas')
    return { ok: true, data: created }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateCampaignAction(
  id: string,
  input: UpdateCampaignInput,
): Promise<ActionResult<CampaignSummary>> {
  try {
    const saved = await serverApi().updateCampaign(id, input)
    revalidatePath('/crm/campanhas')
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * A prévia **não** revalida a rota.
 *
 * Ela não muda nada no servidor, e um `revalidatePath` aqui remontaria a página inteira
 * a cada clique — apagando, de passagem, a prévia que o usuário acabou de pedir.
 */
export async function previewCampaignAction(id: string): Promise<ActionResult<CampaignPreview>> {
  try {
    return { ok: true, data: await serverApi().previewCampaign(id) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function runCampaignAction(
  id: string,
  expectedTargets: number,
): Promise<ActionResult<{ runId: string; targeted: number; sent: number; skipped: number; failed: number }>> {
  try {
    const result = await serverApi().runCampaign(id, { expectedTargets })
    revalidatePath('/crm/campanhas')
    revalidatePath('/crm')
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

export async function cancelCampaignAction(
  id: string,
): Promise<ActionResult<{ cancelledMessages: number }>> {
  try {
    const result = await serverApi().cancelCampaign(id)
    revalidatePath('/crm/campanhas')
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

export async function listCampaignTargetsAction(
  runId: string,
): Promise<ActionResult<CampaignTargetRow[]>> {
  try {
    const response = await serverApi().listCampaignTargets(runId)
    return { ok: true, data: response.data }
  } catch (error) {
    return toFailure(error)
  }
}
