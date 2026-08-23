'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  CreatePetSchema,
  LinkTutorSchema,
  MAX_PHOTO_BYTES,
  UpdatePhotoSchema,
  RecordWeightSchema,
  RegisterDeathSchema,
  RevertDeathSchema,
  TransferPetSchema,
  UpdatePetSchema,
  UpdatePetTutorSchema,
  type Breed,
  type PetResponse,
  type PetPhoto,
  type PetSensitive,
  type PetTutorLink,
  type PetWeightRecord,
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

// ─── Pesagem (MOD-PET-07) ────────────────────────────────────────────────────

/**
 * Registra a pesagem e devolve o ponto já comparado com o anterior — é a variação que
 * a tela mostra, e é ela que o veterinário lê (RN-11).
 */
export async function recordWeightAction(
  petId: string,
  input: unknown,
): Promise<ActionResult<PetWeightRecord>> {
  const parsed = RecordWeightSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const record = await serverApi().recordPetWeight(petId, parsed.data)
    revalidatePath(`/pets/${petId}`)
    revalidatePath('/pets')
    return { ok: true, data: record }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Transferência de titularidade (MOD-PET-05) ──────────────────────────────

export async function transferPetAction(
  petId: string,
  input: unknown,
): Promise<ActionResult<PetResponse>> {
  const parsed = TransferPetSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const pet = await serverApi().transferPet(petId, parsed.data)
    revalidatePath(`/pets/${petId}`)
    revalidatePath('/pets')
    // O tutor anterior deixa de ver o pet e o novo passa a ver: as duas telas de
    // tutor mudam junto (RN-07).
    revalidatePath('/tutores')
    return { ok: true, data: pet }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Óbito (MOD-PET-08) ──────────────────────────────────────────────────────

export async function registerDeathAction(
  petId: string,
  input: unknown,
): Promise<ActionResult<PetResponse>> {
  const parsed = RegisterDeathSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const pet = await serverApi().registerPetDeath(petId, parsed.data)
    revalidatePath(`/pets/${petId}`)
    revalidatePath('/pets')
    revalidatePath('/dashboard')
    return { ok: true, data: pet }
  } catch (error) {
    return toFailure(error)
  }
}

export async function revertDeathAction(
  petId: string,
  input: unknown,
): Promise<ActionResult<PetResponse>> {
  const parsed = RevertDeathSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const pet = await serverApi().revertPetDeath(petId, parsed.data)
    revalidatePath(`/pets/${petId}`)
    revalidatePath('/pets')
    revalidatePath('/dashboard')
    return { ok: true, data: pet }
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

// ─── Álbum de fotos (MOD-PET-04) ─────────────────────────────────────────────

/**
 * O upload sobe o arquivo por Server Action: o `FormData` do formulário atravessa
 * inteiro, e o browser nunca vê o token do Clerk nem a URL do gateway.
 *
 * `FormData` entra e sai como está — reconstruí-lo aqui só recriaria o multipart com
 * outro `boundary`, sem ganho.
 */
export async function uploadPhotosAction(
  petId: string,
  form: FormData,
): Promise<ActionResult<PetPhoto[]>> {
  const files = form.getAll('files').filter((entry): entry is File => entry instanceof File)
  if (files.length === 0) {
    return { ok: false, message: 'Escolha ao menos uma foto.', fieldErrors: {} }
  }

  // A mesma recusa do AC-02, antes da viagem: subir 40 MB para ouvir "não" é tempo do
  // atendente com o cliente na frente.
  const tooBig = files.find((file) => file.size > MAX_PHOTO_BYTES)
  if (tooBig) {
    return {
      ok: false,
      message: `"${tooBig.name}" passa de 10 MB. Envie JPG, PNG, WEBP ou HEIC de até 10 MB.`,
      fieldErrors: {},
    }
  }

  try {
    const photos = await serverApi().uploadPetPhotos(petId, form)
    revalidatePath(`/pets/${petId}`)
    revalidatePath('/pets')
    return { ok: true, data: photos }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updatePhotoAction(
  petId: string,
  photoId: string,
  patch: unknown,
): Promise<ActionResult<PetPhoto>> {
  const parsed = UpdatePhotoSchema.safeParse(patch)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const photo = await serverApi().updatePetPhoto(petId, photoId, parsed.data)
    revalidatePath(`/pets/${petId}`)
    revalidatePath('/pets')
    return { ok: true, data: photo }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deletePhotoAction(
  petId: string,
  photoId: string,
): Promise<ActionResult<null>> {
  try {
    await serverApi().deletePetPhoto(petId, photoId)
    revalidatePath(`/pets/${petId}`)
    revalidatePath('/pets')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
