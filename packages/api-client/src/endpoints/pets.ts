import {
  BreedSchema,
  CoatSchema,
  PaginatedPetsSchema,
  ManagedBreedSchema,
  PetAlbumSchema,
  PetPhotoSchema,
  PetResponseSchema,
  PetSensitiveSchema,
  PetTransferSchema,
  PetTutorSchema,
  PetWeightSchema,
  SizeSchema,
  SpeciesSchema,
  type CreateBreedInput,
  type CreatePetInput,
  type LinkTutorInput,
  type ListPetsQuery,
  type RecordWeightInput,
  type RegisterDeathInput,
  type RevertDeathInput,
  type TransferPetInput,
  type UpdateBreedInput,
  type UpdatePhotoInput,
  type UpdatePetInput,
  type UpdatePetTutorInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function petEndpoints({ request, upload }: Transport) {
  return {
    // ─── MOD-PET ───────────────────────────────────────────────────────────

    listPets: (query: Partial<ListPetsQuery> = {}) =>
      request({
        method: 'GET',
        path: `/v1/pets${toQueryString(query)}`,
        schema: PaginatedPetsSchema,
      }),

    getPet: (id: string) =>
      request({ method: 'GET', path: `/v1/pets/${id}`, schema: PetResponseSchema }),

    createPet: (input: CreatePetInput) =>
      request({ method: 'POST', path: '/v1/pets', body: input, schema: PetResponseSchema }),

    updatePet: (id: string, patch: UpdatePetInput) =>
      request({ method: 'PATCH', path: `/v1/pets/${id}`, body: patch, schema: PetResponseSchema }),

    deletePet: (id: string) => request<void>({ method: 'DELETE', path: `/v1/pets/${id}` }),

    /** Microchip completo. Cada chamada é auditada como `pet.microchip_revealed`. */
    revealMicrochip: (id: string) =>
      request({ method: 'GET', path: `/v1/pets/${id}/sensitive`, schema: PetSensitiveSchema }),

    // ─── Responsáveis (MOD-PET-02) ─────────────────────────────────────────

    listPetTutors: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/pets/${id}/tutors`,
        schema: z.array(PetTutorSchema),
      }),

    linkPetTutor: (id: string, input: LinkTutorInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${id}/tutors`,
        body: input,
        schema: PetTutorSchema,
      }),

    updatePetTutor: (id: string, linkId: string, patch: UpdatePetTutorInput) =>
      request({
        method: 'PATCH',
        path: `/v1/pets/${id}/tutors/${linkId}`,
        body: patch,
        schema: PetTutorSchema,
      }),

    unlinkPetTutor: (id: string, linkId: string) =>
      request<void>({ method: 'DELETE', path: `/v1/pets/${id}/tutors/${linkId}` }),

    // ─── Álbum de fotos (MOD-PET-04) ───────────────────────────────────────

    listPetPhotos: (id: string) =>
      request({ method: 'GET', path: `/v1/pets/${id}/photos`, schema: PetAlbumSchema }),

    /** As URLs que voltam são assinadas e vencem em 15 minutos — não as guarde. */
    uploadPetPhotos: (id: string, form: FormData) =>
      upload(`/v1/pets/${id}/photos`, form, z.array(PetPhotoSchema)),

    updatePetPhoto: (id: string, photoId: string, patch: UpdatePhotoInput) =>
      request({
        method: 'PATCH',
        path: `/v1/pets/${id}/photos/${photoId}`,
        body: patch,
        schema: PetPhotoSchema,
      }),

    deletePetPhoto: (id: string, photoId: string) =>
      request<void>({ method: 'DELETE', path: `/v1/pets/${id}/photos/${photoId}` }),

    // ─── Transferência de titularidade (MOD-PET-05) ────────────────────────

    transferPet: (id: string, input: TransferPetInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${id}/transfer`,
        body: input,
        schema: PetResponseSchema,
      }),

    listPetTransfers: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/pets/${id}/transfers`,
        schema: z.array(PetTransferSchema),
      }),

    // ─── Histórico de peso (MOD-PET-07) ────────────────────────────────────

    listPetWeights: (id: string) =>
      request({ method: 'GET', path: `/v1/pets/${id}/weights`, schema: z.array(PetWeightSchema) }),

    recordPetWeight: (id: string, input: RecordWeightInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${id}/weights`,
        body: input,
        schema: PetWeightSchema,
      }),

    // ─── Óbito (MOD-PET-08) ────────────────────────────────────────────────

    registerPetDeath: (id: string, input: RegisterDeathInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${id}/death`,
        body: input,
        schema: PetResponseSchema,
      }),

    revertPetDeath: (id: string, input: RevertDeathInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${id}/death/reversal`,
        body: input,
        schema: PetResponseSchema,
      }),

    // ─── Catálogo de domínio (MOD-PET-03) ──────────────────────────────────

    listSpecies: () =>
      request({ method: 'GET', path: '/v1/species', schema: z.array(SpeciesSchema) }),

    /** Raças globais da espécie somadas às criadas por este tenant. */
    listBreeds: (speciesId: string) =>
      request({
        method: 'GET',
        path: `/v1/species/${speciesId}/breeds`,
        schema: z.array(BreedSchema),
      }),

    listSizes: () => request({ method: 'GET', path: '/v1/sizes', schema: z.array(SizeSchema) }),

    listCoats: () => request({ method: 'GET', path: '/v1/coats', schema: z.array(CoatSchema) }),

    /** A lista da tela de catálogo: inclui o que está oculto e o uso de cada raça. */
    listManagedBreeds: (speciesId: string) =>
      request({
        method: 'GET',
        path: `/v1/breeds?speciesId=${speciesId}`,
        schema: z.array(ManagedBreedSchema),
      }),

    createBreed: (input: CreateBreedInput) =>
      request({ method: 'POST', path: '/v1/breeds', body: input, schema: BreedSchema }),

    updateBreed: (id: string, patch: UpdateBreedInput) =>
      request({ method: 'PATCH', path: `/v1/breeds/${id}`, body: patch, schema: BreedSchema }),

    /** AC-02/AC-04: some do seletor — por `breed_visibility` ou por `active`. */
    setBreedVisibility: (id: string, hidden: boolean) =>
      request({
        method: 'PATCH',
        path: `/v1/breeds/${id}/visibility`,
        body: { hidden },
        schema: ManagedBreedSchema,
      }),

    deleteBreed: (id: string) => request<void>({ method: 'DELETE', path: `/v1/breeds/${id}` }),
  }
}
