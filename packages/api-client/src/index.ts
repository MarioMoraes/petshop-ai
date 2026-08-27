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
  AllergyCheckResultSchema,
  AllergySchema,
  ManagedBreedSchema,
  MedicalAlertSchema,
  PetAlbumSchema,
  PetPhotoSchema,
  PetResponseSchema,
  SafetyRecordSchema,
  TemperamentSchema,
  PetSensitiveSchema,
  PetTransferSchema,
  PetTutorSchema,
  PetWeightSchema,
  SizeSchema,
  AppointmentResponseSchema,
  AvailabilityResponseSchema,
  BillingSettingsSchema,
  LedgerAccountSchema,
  LedgerEntrySchema,
  PackagePurchaseSchema,
  PaginatedPaymentsSchema,
  PaymentSchema,
  ReceiptSchema,
  ReceivablesSchema,
  CashflowSchema,
  CreditCheckResponseSchema,
  ServicePackageSchema,
  StatementSchema,
  CalendarBlockCreatedSchema,
  CalendarBlockResponseSchema,
  DayViewSchema,
  ProfessionalResponseSchema,
  ProfessionalWithWarningsSchema,
  ResolvedPricingSchema,
  ServiceResponseSchema,
  InvitationPreviewSchema,
  InvitationResponseSchema,
  RoleResponseSchema,
  SlugAvailabilitySchema,
  SpeciesSchema,
  TeamMemberSchema,
  TagSchema,
  TenantResponseSchema,
  TenantSettingsSchema,
  TutorDetailSchema,
  TutorOverviewSchema,
  TutorSensitiveSchema,
  type AcceptInvitationResult,
  type AssignableRoleKey,
  type CreateInvitationInput,
  type MeResponse,
  type OnboardingState,
  type OnboardingStepInput,
  type ProblemDetails,
  type AppointmentResponse,
  type CalendarBlockResponse,
  type BillingSettings,
  type CreateAppointmentInput,
  type CreateCalendarBlockInput,
  type CreateLedgerEntryInput,
  type CreatePackagePurchaseInput,
  type CreatePaymentInput,
  type CreateServicePackageInput,
  type LedgerAccount,
  type LedgerEntry,
  type PackagePurchase,
  type Cashflow,
  type CreditCheckResponse,
  type PaginatedPayments,
  type Payment,
  type Receipt,
  type ServicePackage,
  type Statement,
  type UpdateBillingSettingsInput,
  type UpdatePackagePurchaseInput,
  type UpdateServicePackageInput,
  type CreateProfessionalInput,
  type CreateServiceInput,
  type ProfessionalResponse,
  type ServiceResponse,
  type ScheduleWindow,
  type ServicePricingItem,
  type SlugAvailability,
  type TenantResponse,
  type UpdateProfessionalInput,
  type UpdateServiceInput,
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
  type Allergy,
  type CreateAllergyInput,
  type CreateBreedInput,
  type CreateMedicalAlertInput,
  type CreatePetInput,
  type CreateTagInput,
  type CreateTutorInput,
  type LinkTutorInput,
  type ListPetsQuery,
  type ListTutorsQuery,
  type ManagedBreed,
  type MedicalAlert,
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
  type RecordTemperamentInput,
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
  type SafetyRecord,
  type Temperament,
  type TransferPetInput,
  type UpdateAllergyInput,
  type UpdateBreedInput,
  type UpdateMedicalAlertInput,
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
        // Sem corpo, sem `content-type`. O Fastify 5 do gateway rejeita
        // `application/json` com corpo vazio (`FST_ERR_CTP_EMPTY_JSON_BODY`) — e todo
        // DELETE sem payload (excluir foto, excluir pet, desvincular tutor…) mandava
        // esse header à toa e caía no 500 genérico antes de chegar na rota.
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
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

    // ─── MOD-IDENT-04/06 — equipe e convites ───────────────────────────────

    listTeam: () =>
      request({ method: 'GET', path: '/v1/memberships', schema: z.array(TeamMemberSchema) }),

    listRoles: () =>
      request({ method: 'GET', path: '/v1/roles', schema: z.array(RoleResponseSchema) }),

    changeMemberRole: (membershipId: string, role: AssignableRoleKey) =>
      request({
        method: 'PATCH',
        path: `/v1/memberships/${membershipId}`,
        body: { role },
      }),

    listInvitations: () =>
      request({
        method: 'GET',
        path: '/v1/invitations',
        schema: z.array(InvitationResponseSchema),
      }),

    createInvitation: (input: CreateInvitationInput) =>
      request({
        method: 'POST',
        path: '/v1/invitations',
        body: input,
        schema: InvitationResponseSchema,
      }),

    resendInvitation: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/invitations/${id}/resend`,
        schema: InvitationResponseSchema,
      }),

    revokeInvitation: (id: string) =>
      request<void>({ method: 'DELETE', path: `/v1/invitations/${id}` }),

    /** Rotas do convidado: exigem sessão, mas nenhum vínculo com o tenant ainda. */
    previewInvitation: (token: string) =>
      request({
        method: 'GET',
        path: `/v1/invitations/preview?token=${encodeURIComponent(token)}`,
        schema: InvitationPreviewSchema,
      }),

    acceptInvitation: (token: string) =>
      request<AcceptInvitationResult>({
        method: 'POST',
        path: '/v1/invitations/accept',
        body: { token },
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

    // ─── Prontuário de segurança (MOD-PRONT-03/04/05) ──────────────────────

    /** Alergias, temperamento e alertas médicos — o que a aba do pet carrega. */
    getSafetyRecord: (petId: string) =>
      request({ method: 'GET', path: `/v1/pets/${petId}/safety-record`, schema: SafetyRecordSchema }),

    createAllergy: (petId: string, input: CreateAllergyInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/allergies`,
        body: input,
        schema: AllergySchema,
      }),

    updateAllergy: (petId: string, allergyId: string, patch: UpdateAllergyInput) =>
      request({
        method: 'PATCH',
        path: `/v1/pets/${petId}/allergies/${allergyId}`,
        body: patch,
        schema: AllergySchema,
      }),

    recordTemperament: (petId: string, input: RecordTemperamentInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/temperament`,
        body: input,
        schema: TemperamentSchema,
      }),

    createMedicalAlert: (petId: string, input: CreateMedicalAlertInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/medical-alerts`,
        body: input,
        schema: MedicalAlertSchema,
      }),

    updateMedicalAlert: (petId: string, alertId: string, patch: UpdateMedicalAlertInput) =>
      request({
        method: 'PATCH',
        path: `/v1/pets/${petId}/medical-alerts/${alertId}`,
        body: patch,
        schema: MedicalAlertSchema,
      }),

    /** RN-03: o serviço esbarra em alguma alergia deste pet? */
    checkAllergies: (petId: string, serviceIds: string[]) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/allergy-check`,
        body: { serviceIds },
        schema: AllergyCheckResultSchema,
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

    // ─── MOD-AGENDA — catálogo (fatia 1) ───────────────────────────────────

    /** `includeInactive` traz o que foi desativado — a tela de gestão precisa ver. */
    listServices: (includeInactive = false) =>
      request({
        method: 'GET',
        path: `/v1/services${includeInactive ? '?includeInactive=true' : ''}`,
        schema: z.array(ServiceResponseSchema),
      }),

    createService: (input: CreateServiceInput) =>
      request({
        method: 'POST',
        path: '/v1/services',
        body: input,
        schema: ServiceResponseSchema,
      }),

    updateService: (id: string, patch: UpdateServiceInput) =>
      request({
        method: 'PATCH',
        path: `/v1/services/${id}`,
        body: patch,
        schema: ServiceResponseSchema,
      }),

    deleteService: (id: string) => request<void>({ method: 'DELETE', path: `/v1/services/${id}` }),

    /** `PUT`: a tabela de preços é substituída inteira, não remendada. */
    replaceServicePricing: (id: string, pricing: ServicePricingItem[]) =>
      request({
        method: 'PUT',
        path: `/v1/services/${id}/pricing`,
        body: { pricing },
        schema: ServiceResponseSchema,
      }),

    /** AC-02: 422 quando o porte não tem preço — nunca um valor interpolado. */
    resolveServicePricing: (id: string, sizeId: string) =>
      request({
        method: 'GET',
        path: `/v1/services/${id}/pricing?sizeId=${sizeId}`,
        schema: ResolvedPricingSchema,
      }),

    listProfessionals: (includeInactive = false) =>
      request({
        method: 'GET',
        path: `/v1/professionals${includeInactive ? '?includeInactive=true' : ''}`,
        schema: z.array(ProfessionalResponseSchema),
      }),

    createProfessional: (input: CreateProfessionalInput) =>
      request({
        method: 'POST',
        path: '/v1/professionals',
        body: input,
        schema: ProfessionalResponseSchema,
      }),

    updateProfessional: (id: string, patch: UpdateProfessionalInput) =>
      request({
        method: 'PATCH',
        path: `/v1/professionals/${id}`,
        body: patch,
        schema: ProfessionalResponseSchema,
      }),

    /** Devolve `warnings[]` quando a jornada passa do horário do tenant (AC-03). */
    replaceProfessionalSchedule: (id: string, windows: ScheduleWindow[]) =>
      request({
        method: 'PUT',
        path: `/v1/professionals/${id}/schedule`,
        body: { windows },
        schema: ProfessionalWithWarningsSchema,
      }),

    listCalendarBlocks: (query: { from: string; to: string; professionalId?: string }) =>
      request({
        method: 'GET',
        path: `/v1/calendar-blocks${toQueryString(query)}`,
        schema: z.array(CalendarBlockResponseSchema),
      }),

    createCalendarBlock: (input: CreateCalendarBlockInput) =>
      request({
        method: 'POST',
        path: '/v1/calendar-blocks',
        body: input,
        schema: CalendarBlockCreatedSchema,
      }),

    deleteCalendarBlock: (id: string) =>
      request<void>({ method: 'DELETE', path: `/v1/calendar-blocks/${id}` }),

    // ─── MOD-AGENDA — agendamentos (fatias 2 e 3) ──────────────────────────

    getDayView: (date: string) =>
      request({
        method: 'GET',
        path: `/v1/agenda/day?date=${date}`,
        schema: DayViewSchema,
      }),

    listAppointments: (query: {
      from?: string
      to?: string
      professionalId?: string
      petId?: string
      status?: string
    }) =>
      request({
        method: 'GET',
        path: `/v1/appointments${toQueryString(query)}`,
        schema: z.array(AppointmentResponseSchema),
      }),

    getAppointment: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/appointments/${id}`,
        schema: AppointmentResponseSchema,
      }),

    /** Horários livres já com a duração e o preço calculados para **este** pet. */
    getAvailability: (query: {
      serviceId: string
      petId: string
      professionalId?: string
      from: string
      to: string
    }) =>
      request({
        method: 'GET',
        path: `/v1/availability${toQueryString(query)}`,
        schema: AvailabilityResponseSchema,
      }),

    createAppointment: (input: CreateAppointmentInput) =>
      request({
        method: 'POST',
        path: '/v1/appointments',
        body: input,
        schema: AppointmentResponseSchema,
      }),

    checkInAppointment: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/appointments/${id}/checkin`,
        schema: AppointmentResponseSchema,
      }),

    checkOutAppointment: (id: string, input: { idempotencyKey: string; weightKg?: number; notes?: string; extraItems?: { serviceId: string }[] }) =>
      request({
        method: 'POST',
        path: `/v1/appointments/${id}/checkout`,
        body: input,
        schema: AppointmentResponseSchema,
      }),

    cancelAppointment: (id: string, input: { reason?: string; waiveFee?: boolean }) =>
      request({
        method: 'POST',
        path: `/v1/appointments/${id}/cancel`,
        body: input,
        schema: AppointmentResponseSchema,
      }),

    rescheduleAppointment: (id: string, input: { startsAt: string; professionalId?: string }) =>
      request({
        method: 'POST',
        path: `/v1/appointments/${id}/reschedule`,
        body: input,
        schema: AppointmentResponseSchema.extend({ rescheduleCount: z.number().int() }),
      }),

    approveAppointment: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/appointments/${id}/approve`,
        schema: AppointmentResponseSchema,
      }),

    // ─── MOD-LEDGER — conta corrente do tutor ──────────────────────────────

    getLedgerAccount: (tutorId: string) =>
      request({
        method: 'GET',
        path: `/v1/ledger/accounts/${tutorId}`,
        schema: LedgerAccountSchema,
      }),

    getStatement: (tutorId: string, query: { from?: string; to?: string; page?: number; limit?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/accounts/${tutorId}/statement${toQueryString(query)}`,
        schema: StatementSchema,
      }),

    createLedgerEntry: (input: CreateLedgerEntryInput) =>
      request({
        method: 'POST',
        path: '/v1/ledger/entries',
        body: input,
        schema: LedgerEntrySchema,
      }),

    reverseLedgerEntry: (id: string, input: { reason: string }) =>
      request({
        method: 'POST',
        path: `/v1/ledger/entries/${id}/reverse`,
        body: input,
        schema: z.object({ entryId: z.uuid(), reversalEntryId: z.uuid() }),
      }),

    createPayment: (input: CreatePaymentInput) =>
      request({
        method: 'POST',
        path: '/v1/payments',
        body: input,
        schema: PaymentSchema,
      }),

    listPayments: (query: { tutorId?: string; from?: string; to?: string; method?: string; page?: number; limit?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/payments${toQueryString(query)}`,
        schema: PaginatedPaymentsSchema,
      }),

    reversePayment: (id: string, input: { reason: string }) =>
      request({
        method: 'POST',
        path: `/v1/payments/${id}/reverse`,
        body: input,
        schema: z.object({ paymentId: z.uuid(), reversalEntryId: z.uuid() }),
      }),

    listServicePackages: (query: { includeInactive?: boolean } = {}) =>
      request({
        method: 'GET',
        path: `/v1/packages${toQueryString(query)}`,
        schema: z.object({ data: z.array(ServicePackageSchema) }),
      }),

    createServicePackage: (input: CreateServicePackageInput) =>
      request({
        method: 'POST',
        path: '/v1/packages',
        body: input,
        schema: z.object({ id: z.uuid() }),
      }),

    updateServicePackage: (id: string, input: UpdateServicePackageInput) =>
      request({
        method: 'PATCH',
        path: `/v1/packages/${id}`,
        body: input,
        schema: z.object({ id: z.uuid() }),
      }),

    purchasePackage: (packageId: string, input: CreatePackagePurchaseInput) =>
      request({
        method: 'POST',
        path: `/v1/packages/${packageId}/purchases`,
        body: input,
        schema: PackagePurchaseSchema,
      }),

    listTutorPackages: (tutorId: string) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${tutorId}/packages`,
        schema: z.object({ data: z.array(PackagePurchaseSchema) }),
      }),

    updatePackagePurchase: (id: string, input: UpdatePackagePurchaseInput) =>
      request({
        method: 'PATCH',
        path: `/v1/packages/purchases/${id}`,
        body: input,
        schema: PackagePurchaseSchema,
      }),

    getBillingSettings: () =>
      request({
        method: 'GET',
        path: '/v1/billing-settings',
        schema: BillingSettingsSchema,
      }),

    updateBillingSettings: (input: UpdateBillingSettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/billing-settings',
        body: input,
        schema: BillingSettingsSchema,
      }),

    /** MOD-LEDGER-08 — número, status e URL assinada. Nunca o PDF em stream. */
    getReceipt: (paymentId: string) =>
      request({
        method: 'GET',
        path: `/v1/payments/${paymentId}/receipt`,
        schema: ReceiptSchema,
      }),

    /** MOD-LEDGER-09 — o que a agenda pergunta antes de marcar. Sempre 200. */
    creditCheck: (tutorId: string, amountCents = 0) =>
      request({
        method: 'GET',
        path: `/v1/ledger/accounts/${tutorId}/credit-check?amountCents=${amountCents}`,
        schema: CreditCheckResponseSchema,
      }),

    getReceivables: () =>
      request({
        method: 'GET',
        path: '/v1/ledger/reports/receivables',
        schema: ReceivablesSchema,
      }),

    /** Sem `from`/`to`, o dia de hoje no fuso do estabelecimento. */
    getCashflow: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/reports/cashflow${toQueryString(query)}`,
        schema: CashflowSchema,
      }),
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
  Allergy,
  Breed,
  CepLookup,
  Coat,
  CheckDuplicatesResult,
  ConsentsResponse,
  ManagedBreed,
  MedicalAlert,
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
  SafetyRecord,
  Size,
  AppointmentResponse,
  BillingSettings,
  CalendarBlockResponse,
  LedgerAccount,
  LedgerEntry,
  PackagePurchase,
  Cashflow,
  CreditCheckResponse,
  PaginatedPayments,
  Payment,
  ProfessionalResponse,
  Receipt,
  ServicePackage,
  ServiceResponse,
  SlugAvailability,
  Statement,
  Species,
  Tag,
  Temperament,
  TenantResponse,
  TenantSettings,
  TutorDetail,
  TutorOverview,
  TutorSensitive,
}
