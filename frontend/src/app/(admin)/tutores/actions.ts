'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  AcceptTermSchema,
  AddressInputSchema,
  AnonymizeTutorSchema,
  CreateTutorSchema,
  UpdateConsentsSchema,
  UpdateTutorSchema,
  type CepLookup,
  type CheckDuplicatesResult,
  type DocumentView,
  type DuplicateCandidate,
  type TermAcceptanceView,
  type TermKind,
  type TermVersionView,
  type TutorDetail,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações da área de tutores (MOD-TUTOR).
 *
 * Rodam no servidor: o token do Clerk e a URL do gateway nunca chegam ao browser.
 * Cada ação devolve um resultado discriminado em vez de lançar — o formulário
 * precisa mostrar o erro no campo certo, não uma tela de erro.
 */

/** Cadastro já existente, devolvido no ERR_TUTOR_004 bloqueante. */
export interface ExistingTutorHint {
  id: string
  fullName: string
  phoneMasked: string
  status: string
  suggestedAction: 'OPEN_EXISTING' | 'REACTIVATE_EXISTING'
}

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /** ERR_TUTOR_004 com cadastro existente: a UI oferece abrir ou reativar. */
  existingTutor?: ExistingTutorHint
  /** ERR_TUTOR_004 de duplicata provável: a UI pede confirmação. */
  duplicates?: DuplicateCandidate[]
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const problem = error.problem as Record<string, unknown> | null
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(problem?.existingTutor
        ? { existingTutor: problem.existingTutor as ExistingTutorHint }
        : {}),
      ...(problem?.requiresAcknowledgement
        ? { duplicates: problem.candidates as DuplicateCandidate[] }
        : {}),
    }
  }
  // Gateway fora do ar, DNS, timeout: o usuário não tem o que fazer com o detalhe.
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

function fromZod(error: z.ZodError): ActionFailure {
  return {
    ok: false,
    message: error.issues[0]?.message ?? 'Dados inválidos',
    fieldErrors: Object.fromEntries(
      error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
    ),
  }
}

// ─── Cadastro e edição ───────────────────────────────────────────────────────

export async function createTutorAction(input: unknown): Promise<ActionResult<TutorDetail>> {
  const parsed = CreateTutorSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tutor = await serverApi().createTutor(parsed.data)
    revalidatePath('/tutores')
    return { ok: true, data: tutor }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateTutorAction(
  id: string,
  input: unknown,
): Promise<ActionResult<TutorDetail>> {
  const parsed = UpdateTutorSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tutor = await serverApi().updateTutor(id, parsed.data)
    revalidatePath('/tutores')
    revalidatePath(`/tutores/${id}`)
    return { ok: true, data: tutor }
  } catch (error) {
    return toFailure(error)
  }
}

export async function reactivateTutorAction(id: string): Promise<ActionResult<TutorDetail>> {
  try {
    const tutor = await serverApi().reactivateTutor(id)
    revalidatePath('/tutores')
    revalidatePath(`/tutores/${id}`)
    return { ok: true, data: tutor }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deleteTutorAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deleteTutor(id)
    revalidatePath('/tutores')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

export async function anonymizeTutorAction(
  id: string,
  input: unknown,
): Promise<ActionResult<null>> {
  const parsed = AnonymizeTutorSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    await serverApi().anonymizeTutor(id, parsed.data)
    revalidatePath('/tutores')
    revalidatePath(`/tutores/${id}`)
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Deduplicação e CEP ──────────────────────────────────────────────────────

/**
 * Chamada no blur do campo nome (AC-02 de MOD-TUTOR-02). Falhar aqui não pode
 * travar o formulário: quem decide de verdade é o 409 do POST.
 */
export async function checkDuplicatesAction(input: {
  fullName?: string
  phone?: string
  email?: string
  cpf?: string
  excludeTutorId?: string
}): Promise<CheckDuplicatesResult | null> {
  if (!input.fullName && !input.phone && !input.email && !input.cpf) return null
  try {
    return await serverApi().checkDuplicates(input)
  } catch {
    return null
  }
}

/** Preenchimento por CEP. `null` quando o CEP não existe ou o ViaCEP está fora. */
export async function lookupCepAction(cep: string): Promise<CepLookup | null> {
  const digits = cep.replace(/\D/g, '')
  if (digits.length !== 8) return null
  try {
    return await serverApi().lookupCep(digits)
  } catch {
    return null
  }
}

// ─── Endereços, consentimentos e tags ────────────────────────────────────────

export async function addAddressAction(
  tutorId: string,
  input: unknown,
): Promise<ActionResult<null>> {
  const parsed = AddressInputSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    await serverApi().addAddress(tutorId, parsed.data)
    revalidatePath(`/tutores/${tutorId}`)
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateConsentsAction(
  tutorId: string,
  input: unknown,
): Promise<ActionResult<null>> {
  const parsed = UpdateConsentsSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    await serverApi().updateConsents(tutorId, parsed.data)
    revalidatePath(`/tutores/${tutorId}`)
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Termos e autorizações (MOD-DOC-07 e 08) ─────────────────────────────────

/** O texto vigente, para a tela apresentar antes de colher o aceite. */
export async function getCurrentTermAction(
  kind: TermKind,
): Promise<ActionResult<TermVersionView>> {
  try {
    return { ok: true, data: await serverApi().getCurrentTerm(kind) }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Registra o aceite e emite o papel.
 *
 * O IP e o user-agent que viram prova são os que o gateway encaminha, e não os do
 * servidor do Next: a ação chama a API como qualquer outra tela, e o `serverApi` já
 * repassa os cabeçalhos de origem.
 */
export async function acceptTermAction(
  tutorId: string,
  kind: TermKind,
): Promise<ActionResult<TermAcceptanceView>> {
  const parsed = AcceptTermSchema.safeParse({ kind })
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const acceptance = await serverApi().acceptTerm(tutorId, parsed.data)
    revalidatePath(`/tutores/${tutorId}`)
    return { ok: true, data: acceptance }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * A URL assinada de 15 minutos do papel — e pedi-la **é** o download: esta chamada entra
 * na trilha de auditoria do tenant. Por isso ela sai daqui, do clique, e não da listagem.
 */
export async function getTutorDocumentAction(
  tutorId: string,
  documentId: string,
): Promise<ActionResult<DocumentView>> {
  try {
    return { ok: true, data: await serverApi().getTutorDocument(tutorId, documentId) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function assignTagAction(
  tagId: string,
  tutorIds: string[],
): Promise<ActionResult<null>> {
  try {
    await serverApi().assignTag(tagId, tutorIds)
    revalidatePath('/tutores')
    for (const id of tutorIds) revalidatePath(`/tutores/${id}`)
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

export async function removeTagAction(
  tutorId: string,
  tagId: string,
): Promise<ActionResult<null>> {
  try {
    await serverApi().removeTag(tutorId, tagId)
    revalidatePath(`/tutores/${tutorId}`)
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
