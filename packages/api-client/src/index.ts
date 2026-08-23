import {
  AddressResponseSchema,
  BreedSchema,
  CepLookupSchema,
  CheckDuplicatesResultSchema,
  CoatSchema,
  ConsentsResponseSchema,
  MeResponseSchema,
  OnboardingStateSchema,
  PaginatedPetsSchema,
  PaginatedTutorsSchema,
  ManagedBreedSchema,
  PetAlbumSchema,
  PetPhotoSchema,
  PetResponseSchema,
  PetSensitiveSchema,
  PetTransferSchema,
  PetTutorSchema,
  PetWeightSchema,
  SizeSchema,
  SlugAvailabilitySchema,
  SpeciesSchema,
  TagSchema,
  TenantResponseSchema,
  TenantSettingsSchema,
  TutorDetailSchema,
  TutorOverviewSchema,
  TutorSensitiveSchema,
  type MeResponse,
  type OnboardingState,
  type OnboardingStepInput,
  type ProblemDetails,
  type SlugAvailability,
  type TenantResponse,
  type TenantSettings,
  type AddressInput,
  type AddressResponse,
  type AnonymizeTutorInput,
  type Breed,
  type CepLookup,
  type Coat,
  type CheckDuplicatesInput,
  type CheckDuplicatesResult,
  type ConsentsResponse,
  type CreateBreedInput,
  type CreatePetInput,
  type CreateTagInput,
  type CreateTutorInput,
  type LinkTutorInput,
  type ListPetsQuery,
  type ListTutorsQuery,
  type ManagedBreed,
  type MergeTutorInput,
  type PetAlbum,
  type PetPhoto,
  type PaginatedPets,
  type PaginatedTutors,
  type PetResponse,
  type PetSensitive,
  type PetTransfer,
  type PetTutorLink,
  type PetWeightRecord,
  type RecordWeightInput,
  type RegisterDeathInput,
  type RevertDeathInput,
  type Size,
  type Species,
  type Tag,
  type TutorDetail,
  type TutorOverview,
  type TutorSensitive,
  type UpdateAddressInput,
  type UpdateConsentsInput,
  type TransferPetInput,
  type UpdateBreedInput,
  type UpdatePhotoInput,
  type UpdatePetInput,
  type UpdatePetTutorInput,
  type UpdateTenantSettingsInput,
  type UpdateTutorInput,
} from '@petshop/shared-types'
import { z, type ZodType } from 'zod'

/**
 * Cliente tipado do api-gateway.
 *
 * As respostas são validadas com os mesmos schemas Zod que o backend usa para
 * responder. Um contrato quebrado aparece como erro claro no cliente, em vez de
 * `undefined` propagando até a tela.
 */

export class ApiError extends Error {
  readonly status: number
  readonly problem: ProblemDetails | null

  constructor(status: number, problem: ProblemDetails | null, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }

  /** Mensagem por campo, no formato que os formulários consomem. */
  get fieldErrors(): Record<string, string> {
    const entries = this.problem?.errors?.map((error) => [error.field, error.message] as const)
    return Object.fromEntries(entries ?? [])
  }

  get code(): string | null {
    return this.problem?.code ?? null
  }
}

export interface ApiClientOptions {
  baseUrl: string
  /** Token de sessão do Clerk. Resolvido por requisição, nunca guardado. */
  getToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
}

interface RequestOptions<T> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  schema?: ZodType<T>
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? fetch

  async function request<T>({ method, path, body, schema }: RequestOptions<T>): Promise<T> {
    const token = await options.getToken()

    const response = await doFetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    })

    if (!response.ok) {
      const problem = await readProblem(response)
      throw new ApiError(
        response.status,
        problem,
        problem?.detail ?? `Falha na requisição (${response.status})`,
      )
    }

    if (response.status === 204) return undefined as T
    const payload = (await response.json()) as unknown
    if (!schema) return payload as T

    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        null,
        `Resposta fora do contrato em ${path}: ${parsed.error.issues[0]?.message ?? 'formato inesperado'}`,
      )
    }
    return parsed.data
  }

  /**
   * Envio de arquivo. Não passa pelo `request` porque o `content-type` aqui é do
   * `FormData` — com o `boundary` que só ele conhece. Fixar `application/json`, como
   * o `request` faz, quebraria o multipart no primeiro byte.
   */
  async function upload<T>(path: string, form: FormData, schema?: ZodType<T>): Promise<T> {
    const token = await options.getToken()

    const response = await doFetch(`${options.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: form,
      cache: 'no-store',
    })

    if (!response.ok) {
      const problem = await readProblem(response)
      throw new ApiError(
        response.status,
        problem,
        problem?.detail ?? `Falha no envio (${response.status})`,
      )
    }

    const payload = (await response.json()) as unknown
    if (!schema) return payload as T

    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        null,
        `Resposta fora do contrato em ${path}: ${parsed.error.issues[0]?.message ?? 'formato inesperado'}`,
      )
    }
    return parsed.data
  }

  return {
    me: () => request({ method: 'GET', path: '/v1/me', schema: MeResponseSchema }),

    createTenant: (input: {
      name: string
      slug: string
      legalName?: string
      cnpj?: string
      plan?: string
      timezone?: string
    }) =>
      request({
        method: 'POST',
        path: '/v1/tenants',
        body: input,
        schema: TenantResponseSchema,
      }),

    getTenant: () =>
      request({ method: 'GET', path: '/v1/tenants/me', schema: TenantResponseSchema }),

    updateTenant: (input: { name?: string; legalName?: string | null; cnpj?: string | null }) =>
      request({
        method: 'PATCH',
        path: '/v1/tenants/me',
        body: input,
        schema: TenantResponseSchema,
      }),

    checkSlug: (slug: string) =>
      request({
        method: 'GET',
        path: `/v1/tenants/slug-availability?slug=${encodeURIComponent(slug)}`,
        schema: SlugAvailabilitySchema,
      }),

    getOnboarding: () =>
      request({
        method: 'GET',
        path: '/v1/tenants/me/onboarding',
        schema: OnboardingStateSchema,
      }),

    advanceOnboarding: (payload: OnboardingStepInput) =>
      request({
        method: 'PATCH',
        path: '/v1/tenants/me/onboarding',
        body: payload,
        schema: TenantResponseSchema,
      }),

    getSettings: () =>
      request({
        method: 'GET',
        path: '/v1/tenants/me/settings',
        schema: TenantSettingsSchema,
      }),

    updateSettings: (patch: UpdateTenantSettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/tenants/me/settings',
        body: patch,
        schema: TenantSettingsSchema,
      }),

    // ─── MOD-TUTOR ─────────────────────────────────────────────────────────

    listTutors: (query: Partial<ListTutorsQuery> = {}) =>
      request({
        method: 'GET',
        path: `/v1/tutors${toQueryString(query)}`,
        schema: PaginatedTutorsSchema,
      }),

    getTutor: (id: string) =>
      request({ method: 'GET', path: `/v1/tutors/${id}`, schema: TutorDetailSchema }),

    getTutorOverview: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${id}/overview`,
        schema: TutorOverviewSchema,
      }),

    createTutor: (input: CreateTutorInput) =>
      request({ method: 'POST', path: '/v1/tutors', body: input, schema: TutorDetailSchema }),

    updateTutor: (id: string, patch: UpdateTutorInput) =>
      request({ method: 'PATCH', path: `/v1/tutors/${id}`, body: patch, schema: TutorDetailSchema }),

    deleteTutor: (id: string) => request<void>({ method: 'DELETE', path: `/v1/tutors/${id}` }),

    anonymizeTutor: (id: string, input: AnonymizeTutorInput) =>
      request<void>({ method: 'POST', path: `/v1/tutors/${id}/anonymize`, body: input }),

    reactivateTutor: (id: string) =>
      request({ method: 'POST', path: `/v1/tutors/${id}/reactivate`, schema: TutorDetailSchema }),

    mergeTutors: (targetId: string, input: MergeTutorInput) =>
      request<{ targetId: string; sourceId: string }>({
        method: 'POST',
        path: `/v1/tutors/${targetId}/merge`,
        body: input,
      }),

    checkDuplicates: (input: CheckDuplicatesInput) =>
      request({
        method: 'POST',
        path: '/v1/tutors/check-duplicates',
        body: input,
        schema: CheckDuplicatesResultSchema,
      }),

    /** Documento e telefone sem máscara. Cada chamada é auditada no serviço. */
    revealTutorData: (id: string) =>
      request({ method: 'GET', path: `/v1/tutors/${id}/sensitive`, schema: TutorSensitiveSchema }),

    getConsents: (id: string) =>
      request({ method: 'GET', path: `/v1/tutors/${id}/consents`, schema: ConsentsResponseSchema }),

    updateConsents: (id: string, input: UpdateConsentsInput) =>
      request({
        method: 'PUT',
        path: `/v1/tutors/${id}/consents`,
        body: input,
        schema: ConsentsResponseSchema,
      }),

    listAddresses: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${id}/addresses`,
        schema: z.array(AddressResponseSchema),
      }),

    addAddress: (id: string, input: AddressInput) =>
      request({
        method: 'POST',
        path: `/v1/tutors/${id}/addresses`,
        body: input,
        schema: AddressResponseSchema,
      }),

    updateAddress: (id: string, addressId: string, patch: UpdateAddressInput) =>
      request({
        method: 'PATCH',
        path: `/v1/tutors/${id}/addresses/${addressId}`,
        body: patch,
        schema: AddressResponseSchema,
      }),

    lookupCep: (cep: string) =>
      request({
        method: 'GET',
        path: `/v1/tutors/cep-lookup?cep=${encodeURIComponent(cep)}`,
        schema: CepLookupSchema,
      }),

    listTags: () =>
      request({ method: 'GET', path: '/v1/tutors/tags', schema: z.array(TagSchema) }),

    createTag: (input: CreateTagInput) =>
      request({ method: 'POST', path: '/v1/tutors/tags', body: input, schema: TagSchema }),

    assignTag: (tagId: string, tutorIds: string[]) =>
      request<{ assigned: number; alreadyAssigned: number }>({
        method: 'POST',
        path: `/v1/tutors/tags/${tagId}/assign`,
        body: { tutorIds },
      }),

    removeTag: (tutorId: string, tagId: string) =>
      request<void>({ method: 'DELETE', path: `/v1/tutors/${tutorId}/tags/${tagId}` }),

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

/** Monta a query string ignorando o que não foi preenchido. */
function toQueryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

export type ApiClient = ReturnType<typeof createApiClient>

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  try {
    const payload = (await response.json()) as ProblemDetails
    return typeof payload?.code === 'string' ? payload : null
  } catch {
    return null
  }
}

export type {
  AddressResponse,
  Breed,
  CepLookup,
  Coat,
  CheckDuplicatesResult,
  ConsentsResponse,
  ManagedBreed,
  MeResponse,
  OnboardingState,
  PaginatedPets,
  PetAlbum,
  PetPhoto,
  PaginatedTutors,
  PetResponse,
  PetSensitive,
  PetTransfer,
  PetTutorLink,
  PetWeightRecord,
  Size,
  SlugAvailability,
  Species,
  Tag,
  TenantResponse,
  TenantSettings,
  TutorDetail,
  TutorOverview,
  TutorSensitive,
}
