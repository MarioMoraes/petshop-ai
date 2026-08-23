'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  CreatePetSchema,
  LinkTutorSchema,
  UpdatePetSchema,
  UpdatePetTutorSchema,
  type Breed,
  type PetResponse,
  type PetSensitive,
  type PetTutorLink,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações da área de pets (MOD-PET).
 *
 * Rodam no servidor: o token do Clerk e a URL do gateway nunca chegam ao browser.
 * Cada ação devolve um resultado discriminado em vez de lançar — o formulário precisa
 * mostrar o erro no campo certo, não uma tela de erro.
 */

/** Pet já cadastrado, devolvido no 409 de microchip repetido (RN-15). */
export interface ExistingPetHint {
  id: string
  name: string
  status: string
}

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /** ERR_PET_004 de microchip duplicado: a UI oferece abrir o cadastro existente. */
  existingPet?: ExistingPetHint
  /** ERR_PET_005 ao remover o último responsável: aponta a transferência. */
  transferPath?: string
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const problem = error.problem as Record<string, unknown> | null
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(problem?.existingPet ? { existingPet: problem.existingPet as ExistingPetHint } : {}),
      ...(typeof problem?.transferPath === 'string' ? { transferPath: problem.transferPath } : {}),
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
  const fieldErrors = Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
  )
  return { ok: false, message: error.issues[0]?.message ?? 'Dados inválidos', fieldErrors }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createPetAction(input: unknown): Promise<ActionResult<PetResponse>> {
  const parsed = CreatePetSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const pet = await serverApi().createPet(parsed.data)
    revalidatePath('/pets')
    revalidatePath('/dashboard')
    return { ok: true, data: pet }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updatePetAction(
  id: string,
  patch: unknown,
): Promise<ActionResult<PetResponse>> {
  const parsed = UpdatePetSchema.safeParse(patch)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const pet = await serverApi().updatePet(id, parsed.data)
    revalidatePath('/pets')
    revalidatePath(`/pets/${id}`)
    return { ok: true, data: pet }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deletePetAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deletePet(id)
    revalidatePath('/pets')
    revalidatePath('/dashboard')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

/** Microchip completo. Cada leitura vira `pet.microchip_revealed` na trilha. */
export async function revealMicrochipAction(id: string): Promise<ActionResult<PetSensitive>> {
  try {
    return { ok: true, data: await serverApi().revealMicrochip(id) }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Responsáveis (MOD-PET-02) ───────────────────────────────────────────────

export async function linkTutorAction(
  petId: string,
  input: unknown,
): Promise<ActionResult<PetTutorLink>> {
  const parsed = LinkTutorSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const link = await serverApi().linkPetTutor(petId, parsed.data)
    revalidatePath(`/pets/${petId}`)
    return { ok: true, data: link }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updatePetTutorAction(
  petId: string,
  linkId: string,
  patch: unknown,
): Promise<ActionResult<PetTutorLink>> {
  const parsed = UpdatePetTutorSchema.safeParse(patch)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const link = await serverApi().updatePetTutor(petId, linkId, parsed.data)
    revalidatePath(`/pets/${petId}`)
    return { ok: true, data: link }
  } catch (error) {
    return toFailure(error)
  }
}

export async function unlinkTutorAction(
  petId: string,
  linkId: string,
): Promise<ActionResult<null>> {
  try {
    await serverApi().unlinkPetTutor(petId, linkId)
    revalidatePath(`/pets/${petId}`)
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Apoio aos seletores do formulário ───────────────────────────────────────

/**
 * Raças da espécie escolhida. Vive como ação porque a lista muda no meio do
 * preenchimento — o servidor não tem como saber de antemão qual espécie o atendente
 * vai escolher.
 */
export async function listBreedsAction(speciesId: string): Promise<Breed[]> {
  try {
    return await serverApi().listBreeds(speciesId)
  } catch {
    // Sem raça o cadastro ainda fecha: `breedId` é opcional, e nem todo cadastro
    // sabe a raça. Falhar aqui não pode travar o formulário.
    return []
  }
}

export interface TutorOption {
  id: string
  displayName: string
  phoneMasked: string
}

/** Busca de tutor para vincular ao pet. O POST exige ao menos um responsável. */
export async function searchTutorsAction(query: string): Promise<TutorOption[]> {
  if (query.trim().length < 2) return []
  try {
    const page = await serverApi().listTutors({ q: query, limit: 8 })
    return page.data.map((tutor) => ({
      id: tutor.id,
      displayName: tutor.displayName,
      phoneMasked: tutor.phoneMasked,
    }))
  } catch {
    return []
  }
}
