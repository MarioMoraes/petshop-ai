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
  PortalAdoptionSchema,
  AllergyCheckResultSchema,
  AllergySchema,
  AttendanceSchema,
  PetClinicalSummarySchema,
  TimelinePageSchema,
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
  PendingApprovalsSchema,
  BillingSettingsSchema,
  LedgerAccountSchema,
  LedgerEntrySchema,
  PackagePurchaseSchema,
  PaginatedPaymentsSchema,
  PaymentSchema,
  ReceiptSchema,
  ReceivablesSchema,
  AccountsReceivableReportSchema,
  ReceiptsByDayReportSchema,
  CashflowSchema,
  CreditCheckResponseSchema,
  ServicePackageSchema,
  StatementSchema,
  CalendarBlockCreatedSchema,
  CalendarBlockResponseSchema,
  DayViewSchema,
  MovementResponseSchema,
  BookingSourcesSchema,
  AvailableTaxiDriverSchema,
  ClosedTaxiRideSchema,
  AutomationResponseSchema,
  MessageStatsSchema,
  MessageSummarySchema,
  MessagingSettingsResponseSchema,
  PaginatedMessagesSchema,
  ResolvedTemplateSchema,
  SuppressionResponseSchema,
  TemplatePreviewSchema,
  WhatsappConnectionSchema,
  PaginatedTaxiRidesSchema,
  TaxiBoardSchema,
  TaxiQuoteSchema,
  TaxiRideResponseSchema,
  TaxiRidesCreatedSchema,
  TaxiRouteSchema,
  TaxiOperationReportSchema,
  TaxiSettingsSchema,
  TaxiVehicleResponseSchema,
  TaxiZoneResponseSchema,
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
  SiteLeadCountSchema,
  SiteLeadListSchema,
  SiteLeadSchema,
  SitePhotoSchema,
  SitePreviewSchema,
  SiteSettingsSchema,
  TenantResponseSchema,
  TenantSettingsSchema,
  TutorDetailSchema,
  TutorOverviewSchema,
  TutorSensitiveSchema,
  type AcceptInvitationResult,
  type AssignableRoleKey,
  type CreateInvitationInput,
  type MeResponse,
  type CreateSuppressionInput,
  type MessageCategory,
  type MessageChannel,
  type MessageStatus,
  type PreviewTemplateInput,
  type SiteContentPatch,
  type SiteLeadPatch,
  type SiteLeadStatus,
  type SitePhotoPatch,
  type UpdateAutomationInput,
  type UpdateMessagingSettingsInput,
  type UpsertMessageTemplateInput,
  type OnboardingState,
  type OnboardingStepInput,
  type ProblemDetails,
  type AppointmentResponse,
  type CalendarBlockResponse,
  type AssignTaxiRideInput,
  type CancelTaxiRideInput,
  type CreateTaxiRidesInput,
  type FailTaxiRideInput,
  type PaginatedTaxiRides,
  type TaxiBoard,
  type TaxiQuote,
  type TaxiRideResponse,
  type TaxiRoute,
  type TaxiSettings,
  type TaxiStatusTransitionInput,
  type TaxiVehicleInput,
  type TaxiVehicleResponse,
  type TaxiZoneInput,
  type TaxiZoneResponse,
  type UpdateTaxiRideInput,
  type UpdateTaxiSettingsInput,
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
  /** Teto por requisição. Ver `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Teto do envio de arquivo. Ver `UPLOAD_TIMEOUT_MS`. */
  uploadTimeoutMs?: number
}

/**
 * Teto de uma chamada ao gateway, incluindo o tempo de emitir o token no Clerk.
 *
 * **Existe por causa do modo de falha, não da lentidão.** Este cliente roda dentro de
 * Server Components: um `await` que nunca volta deixa o RSC pendurado, e o que o
 * usuário vê é uma **página em branco, sem erro nenhum** — nem overlay do Next, nem
 * linha no terminal. Fica assim para sempre, e não há o que investigar depois.
 *
 * Trinta segundos é folgado de propósito: o SLO mais frouxo do PRD §10 é de 2s no p95,
 * então nada saudável chega perto. O número não é para cortar requisição lenta — é
 * para garantir que toda espera termine em erro visível.
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * Teto do envio de arquivo — quatro vezes o das demais chamadas.
 *
 * Aqui o que atravessa a rede são bytes de imagem, não um JSON de resposta: numa
 * conexão de celular ruim, um envio que vai dar certo passa dos 30s sem nenhum
 * problema, e cortá-lo seria recusar trabalho válido. Dois minutos é largo o bastante
 * para isso e curto o bastante para não ser "nunca".
 */
export const UPLOAD_TIMEOUT_MS = 120_000

interface RequestOptions<T> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  schema?: ZodType<T>
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS

  async function request<T>({ method, path, body, schema }: RequestOptions<T>): Promise<T> {
    // O relógio começa antes do `getToken` porque ele também é rede: emitir o token do
    // template no Clerk é uma ida à internet, e pendurar ali é tão invisível quanto
    // pendurar no gateway.
    const controller = new AbortController()
    const alarme = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await send()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          504,
          null,
          'O servidor demorou demais para responder. Tente novamente em instantes.',
        )
      }
      throw error
    } finally {
      clearTimeout(alarme)
    }

    async function send(): Promise<T> {
      const token = await options.getToken()
      if (controller.signal.aborted) throw new Error('abortado')

      const response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        signal: controller.signal,
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
  }

  /**
   * Envio de arquivo. Não passa pelo `request` porque o `content-type` aqui é do
   * `FormData` — com o `boundary` que só ele conhece. Fixar `application/json`, como
   * o `request` faz, quebraria o multipart no primeiro byte.
   *
   * Teto próprio, e mais largo, pela mesma razão: o que sobe aqui é foto de pet, e
   * subir bytes por uma conexão ruim leva legitimamente muito mais tempo que responder
   * um JSON. Cortar em 30s recusaria envio que ia dar certo. Mas ficar **sem** teto
   * repete o modo de falha que `REQUEST_TIMEOUT_MS` existe para tirar do sistema — um
   * envio pendurado nunca volta, e a tela fica girando sem erro nenhum.
   */
  async function upload<T>(path: string, form: FormData, schema?: ZodType<T>): Promise<T> {
    const controller = new AbortController()
    const alarme = setTimeout(() => controller.abort(), uploadTimeoutMs)

    try {
      return await enviar()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          504,
          null,
          'O envio demorou demais. Verifique sua conexão e tente de novo.',
        )
      }
      throw error
    } finally {
      clearTimeout(alarme)
    }

    async function enviar(): Promise<T> {
      const token = await options.getToken()
      if (controller.signal.aborted) throw new Error('abortado')

      const response = await doFetch(`${options.baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
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
  }

  /**
   * Baixa um documento binário — hoje, os relatórios em PDF do menu Cobrança.
   *
   * Não passa pelo `request` porque ele termina em `response.json()`: o corpo aqui são
   * bytes de PDF, e tentar parseá-los como JSON quebraria antes de qualquer schema. O
   * caminho de erro, esse sim, continua sendo o mesmo — o gateway responde
   * `application/problem+json` também quando a rota pedida devolveria PDF, e é dele que
   * sai a mensagem que a tela mostra.
   *
   * Devolve `Uint8Array`, e não `Blob`: quem chama é um route handler do Next, no
   * servidor, que vai repassar os bytes adiante. O nome do arquivo vem do
   * `content-disposition` do serviço, que é quem sabe o período impresso.
   */
  async function download(path: string, fallbackFilename: string): Promise<DownloadedFile> {
    const controller = new AbortController()
    const alarme = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const token = await options.getToken()
      if (controller.signal.aborted) throw new Error('abortado')

      const response = await doFetch(`${options.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
        cache: 'no-store',
      })

      if (!response.ok) {
        const problem = await readProblem(response)
        throw new ApiError(
          response.status,
          problem,
          problem?.detail ?? `Falha ao gerar o documento (${response.status})`,
        )
      }

      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        filename: filenameFrom(response.headers.get('content-disposition')) ?? fallbackFilename,
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          504,
          null,
          'O documento demorou demais para ser gerado. Tente novamente em instantes.',
        )
      }
      throw error
    } finally {
      clearTimeout(alarme)
    }
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

    /**
     * Adoção do Portal pela carteira: o funil de vínculo e quem voltou nos 30 dias.
     *
     * O terceiro número da faixa — a fatia de agendamentos vinda do Portal — sai de
     * `getBookingSources`, no scheduling-service, que é quem tem a tabela. A tela
     * compõe os dois.
     */
    getPortalAdoption: (query: { days?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/tutors/reports/portal-adoption${toQueryString(query)}`,
        schema: PortalAdoptionSchema,
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

    // ─── Atendimento e linha do tempo (MOD-PRONT-01/02/09/10) ──────────────

    /**
     * O histórico unificado do pet. O servidor decide **o que** cabe na resposta a
     * partir da permissão de quem pergunta (AC-02): não há filtro a aplicar aqui.
     */
    getPetTimeline: (petId: string, query: { limit?: number; cursor?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/pets/${petId}/timeline${toQueryString(query)}`,
        schema: TimelinePageSchema,
      }),

    getPetClinicalSummary: (petId: string) =>
      request({
        method: 'GET',
        path: `/v1/pets/${petId}/summary`,
        schema: PetClinicalSummarySchema,
      }),

    getAttendance: (id: string) =>
      request({ method: 'GET', path: `/v1/attendances/${id}`, schema: AttendanceSchema }),

    listAttendances: (
      query: { petId?: string; appointmentId?: string; limit?: number; cursor?: string } = {},
    ) =>
      request({
        method: 'GET',
        path: `/v1/attendances${toQueryString(query)}`,
        schema: z.object({
          attendances: z.array(AttendanceSchema),
          nextCursor: z.string().nullable(),
        }),
      }),

    /** Correção dentro da janela de 24h; fora dela o servidor devolve 409. */
    updateAttendance: (
      id: string,
      patch: { observations?: string | null; type?: string },
    ) =>
      request({
        method: 'PATCH',
        path: `/v1/attendances/${id}`,
        body: patch,
        schema: AttendanceSchema,
      }),

    addAttendanceAddendum: (id: string, input: { body: string; visibility?: string }) =>
      request({
        method: 'POST',
        path: `/v1/attendances/${id}/addendum`,
        body: input,
        schema: AttendanceSchema,
      }),

    addAttendanceNote: (id: string, input: { body: string; visibility?: string }) =>
      request({
        method: 'POST',
        path: `/v1/attendances/${id}/notes`,
        body: input,
        schema: AttendanceSchema,
      }),

    voidAttendance: (id: string, input: { reason: string }) =>
      request({
        method: 'POST',
        path: `/v1/attendances/${id}/void`,
        body: input,
        schema: AttendanceSchema,
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

    /** A série do painel: `date` é o ÚLTIMO dia da janela, não o primeiro. */
    getMovement: (query: { date?: string; days?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/agenda/movement${toQueryString(query)}`,
        schema: MovementResponseSchema,
      }),

    /**
     * A fatia do Portal nos agendamentos do período — o KPI do PRD-mãe §11.
     *
     * Conta por data de criação e inclui o cancelado: mede por onde o pedido entrou,
     * não o trabalho que saiu. Gate `tenant:configure`, ao contrário do movimento.
     */
    getBookingSources: (query: { days?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/agenda/reports/booking-sources${toQueryString(query)}`,
        schema: BookingSourcesSchema,
      }),

    // ─── MOD-TAXI (PRD taxi_dog_07 §5) ────────────────────────────────────────

    getTaxiSettings: () =>
      request({ method: 'GET', path: '/v1/taxi/settings', schema: TaxiSettingsSchema }),

    updateTaxiSettings: (input: UpdateTaxiSettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/taxi/settings',
        body: input,
        schema: TaxiSettingsSchema,
      }),

    listTaxiZones: () =>
      request({
        method: 'GET',
        path: '/v1/taxi/zones',
        schema: z.object({ items: z.array(TaxiZoneResponseSchema) }),
      }),

    createTaxiZone: (input: TaxiZoneInput) =>
      request({
        method: 'POST',
        path: '/v1/taxi/zones',
        body: input,
        schema: TaxiZoneResponseSchema,
      }),

    updateTaxiZone: (id: string, input: Partial<TaxiZoneInput>) =>
      request({
        method: 'PATCH',
        path: `/v1/taxi/zones/${id}`,
        body: input,
        schema: TaxiZoneResponseSchema,
      }),

    deleteTaxiZone: (id: string) =>
      request({ method: 'DELETE', path: `/v1/taxi/zones/${id}`, schema: z.unknown() }),

    listTaxiVehicles: () =>
      request({
        method: 'GET',
        path: '/v1/taxi/vehicles',
        schema: z.object({ items: z.array(TaxiVehicleResponseSchema) }),
      }),

    createTaxiVehicle: (input: TaxiVehicleInput) =>
      request({
        method: 'POST',
        path: '/v1/taxi/vehicles',
        body: input,
        schema: TaxiVehicleResponseSchema,
      }),

    updateTaxiVehicle: (id: string, input: Partial<TaxiVehicleInput>) =>
      request({
        method: 'PATCH',
        path: `/v1/taxi/vehicles/${id}`,
        body: input,
        schema: TaxiVehicleResponseSchema,
      }),

    /** Preço de uma perna sem criar nada — o Portal e o agente de IA usam esta. */
    getTaxiQuote: (zipCode: string) =>
      request({
        method: 'GET',
        path: `/v1/taxi/quote?zipCode=${zipCode}`,
        schema: TaxiQuoteSchema,
      }),

    listAvailableTaxiDrivers: (windowStartsAt: string, windowEndsAt: string) =>
      request({
        method: 'GET',
        path: `/v1/taxi/drivers/available?windowStartsAt=${encodeURIComponent(windowStartsAt)}&windowEndsAt=${encodeURIComponent(windowEndsAt)}`,
        schema: z.object({ items: z.array(AvailableTaxiDriverSchema) }),
      }),

    listTaxiRides: (query: {
      date?: string
      status?: string
      driverId?: string
      appointmentId?: string
      unassigned?: boolean
      page?: number
      limit?: number
    }) => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value))
      }
      return request({
        method: 'GET',
        path: `/v1/taxi/rides${params.size > 0 ? `?${params.toString()}` : ''}`,
        schema: PaginatedTaxiRidesSchema,
      })
    },

    getTaxiRide: (id: string) =>
      request({ method: 'GET', path: `/v1/taxi/rides/${id}`, schema: TaxiRideResponseSchema }),

    createTaxiRides: (input: CreateTaxiRidesInput) =>
      request({
        method: 'POST',
        path: '/v1/taxi/rides',
        body: input,
        schema: TaxiRidesCreatedSchema,
      }),

    updateTaxiRide: (id: string, input: UpdateTaxiRideInput) =>
      request({
        method: 'PATCH',
        path: `/v1/taxi/rides/${id}`,
        body: input,
        schema: TaxiRideResponseSchema,
      }),

    assignTaxiRide: (id: string, input: AssignTaxiRideInput) =>
      request({
        method: 'POST',
        path: `/v1/taxi/rides/${id}/assign`,
        body: input,
        schema: TaxiRideResponseSchema,
      }),

    advanceTaxiRide: (id: string, input: TaxiStatusTransitionInput) =>
      request({
        method: 'POST',
        path: `/v1/taxi/rides/${id}/status`,
        body: input,
        schema: TaxiRideResponseSchema,
      }),

    failTaxiRide: (id: string, input: FailTaxiRideInput) =>
      request({
        method: 'POST',
        path: `/v1/taxi/rides/${id}/fail`,
        body: input,
        schema: ClosedTaxiRideSchema,
      }),

    cancelTaxiRide: (id: string, input: CancelTaxiRideInput) =>
      request({
        method: 'POST',
        path: `/v1/taxi/rides/${id}/cancel`,
        body: input,
        schema: ClosedTaxiRideSchema,
      }),

    getTaxiBoard: (date?: string) =>
      request({
        method: 'GET',
        path: `/v1/taxi/board${date ? `?date=${date}` : ''}`,
        schema: TaxiBoardSchema,
      }),

    getMyTaxiRoute: (date?: string) =>
      request({
        method: 'GET',
        path: `/v1/taxi/my-route${date ? `?date=${date}` : ''}`,
        schema: TaxiRouteSchema,
      }),

    /**
     * A fila da triagem do Portal, para o sino de pendências. Só o contador e o dia
     * para onde ir — ver `PendingApprovalsSchema`.
     */
    /**
     * Como o leva-e-traz andou — a faixa do Taxi Dog no painel.
     *
     * Recusa com o erro de módulo desligado quando o Taxi está desligado (RN-22): o
     * painel trata isso como "não apurado" e some com a faixa, em vez de anunciar 0%
     * de aderência a quem não faz leva-e-traz.
     */
    getTaxiOperationReport: (query: { days?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/taxi/reports/operation${toQueryString(query)}`,
        schema: TaxiOperationReportSchema,
      }),

    countPendingApprovals: () =>
      request({
        method: 'GET',
        path: '/v1/appointments/pending-count',
        schema: PendingApprovalsSchema,
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
    /**
     * `serviceIds` é lista, e vira uma string com vírgula na query — é assim que a
     * rota a lê. A grade é do conjunto: dois serviços somam duração e preço.
     */
    getAvailability: (query: {
      serviceIds: string[]
      petId: string
      professionalId?: string
      from: string
      to: string
    }) =>
      request({
        method: 'GET',
        path: `/v1/availability${toQueryString({ ...query, serviceIds: query.serviceIds.join(',') })}`,
        schema: AvailabilityResponseSchema,
      }),

    createAppointment: (input: CreateAppointmentInput) =>
      request({
        method: 'POST',
        path: '/v1/appointments',
        body: input,
        schema: AppointmentResponseSchema,
      }),

    /** O encaixe: o pet chegou sem hora marcada e já foi atendido. */
    createWalkIn: (input: {
      petId: string
      professionalId: string
      items: { serviceId: string }[]
      idempotencyKey: string
      weightKg?: number
      notes?: string
    }) =>
      request({
        method: 'POST',
        path: '/v1/appointments/walk-in',
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

    // ─── Cobrança — os relatórios imprimíveis ─────────────────────────────

    /**
     * Contas a receber: quem deve, há quanto tempo e por qual faixa.
     *
     * Difere de `getReceivables`, que continua sendo o total por faixa do painel. Este
     * traz a lista — é o papel de quem vai ligar.
     */
    getAccountsReceivableReport: (query: { asOf?: string; minOverdueDays?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/reports/accounts-receivable${toQueryString(query)}`,
        schema: AccountsReceivableReportSchema,
      }),

    /** Sem `from`/`to`, o mês corrente até hoje no fuso do estabelecimento. */
    getReceiptsByDayReport: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/ledger/reports/receipts-by-day${toQueryString(query)}`,
        schema: ReceiptsByDayReportSchema,
      }),

    downloadAccountsReceivablePdf: (query: { asOf?: string; minOverdueDays?: number } = {}) =>
      download(
        `/v1/ledger/reports/accounts-receivable/pdf${toQueryString(query)}`,
        'contas-a-receber.pdf',
      ),

    downloadReceiptsByDayPdf: (query: { from?: string; to?: string } = {}) =>
      download(
        `/v1/ledger/reports/receipts-by-day/pdf${toQueryString(query)}`,
        'contas-recebidas.pdf',
      ),

    // ─── MOD-CRM (PRD relacionamento_crm_08 §5) ───────────────────────────────

    listMessages: (query: MessageFilters = {}) =>
      request({
        method: 'GET',
        path: `/v1/messages${toQueryString(query)}`,
        schema: PaginatedMessagesSchema,
      }),

    /**
     * O histórico de um tutor mora sob a ficha dele, não em `/v1/messages?tutorId=`.
     * As duas rotas devolvem o mesmo, mas o gateway roteia por prefixo e este é o
     * endereço que o Portal vai herdar quando puder filtrar por dono.
     */
    listTutorMessages: (tutorId: string, query: MessageFilters = {}) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${tutorId}/messages${toQueryString(query)}`,
        schema: PaginatedMessagesSchema,
      }),

    getMessage: (id: string) =>
      request({ method: 'GET', path: `/v1/messages/${id}`, schema: MessageSummarySchema }),

    /** Sem `from`/`to`, o total de todos os tempos — o painel sempre manda a janela. */
    getMessageStats: (query: { from?: string; to?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/messages/stats${toQueryString(query)}`,
        schema: MessageStatsSchema,
      }),

    /** Volta a `QUEUED` com o contador zerado, revalidando consentimento (AC-02). */
    retryMessage: (id: string) =>
      request({ method: 'POST', path: `/v1/messages/${id}/retry`, schema: z.unknown() }),

    cancelMessage: (id: string) =>
      request({ method: 'POST', path: `/v1/messages/${id}/cancel`, schema: z.unknown() }),

    listMessageTemplates: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/templates',
        schema: z.object({ data: z.array(ResolvedTemplateSchema) }),
      }),

    /** PUT, não PATCH: o texto é substituído inteiro, nunca remendado. */
    saveMessageTemplate: (
      key: string,
      channel: MessageChannel,
      input: UpsertMessageTemplateInput,
    ) =>
      request({
        method: 'PUT',
        path: `/v1/messaging/templates/${key}/${channel}`,
        body: input,
        schema: ResolvedTemplateSchema,
      }),

    /** Apaga o override e devolve o texto de fábrica. 409 se nunca houve override. */
    resetMessageTemplate: (key: string, channel: MessageChannel) =>
      request({
        method: 'DELETE',
        path: `/v1/messaging/templates/${key}/${channel}`,
        schema: ResolvedTemplateSchema,
      }),

    previewMessageTemplate: (input: PreviewTemplateInput) =>
      request({
        method: 'POST',
        path: '/v1/messaging/templates/preview',
        body: input,
        schema: TemplatePreviewSchema,
      }),

    getMessagingSettings: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/settings',
        schema: MessagingSettingsResponseSchema,
      }),

    updateMessagingSettings: (input: UpdateMessagingSettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/messaging/settings',
        body: input,
        schema: MessagingSettingsResponseSchema,
      }),

    listMessagingSuppressions: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/suppressions',
        schema: z.object({ data: z.array(SuppressionResponseSchema) }),
      }),

    createMessagingSuppression: (input: CreateSuppressionInput) =>
      request({
        method: 'POST',
        path: '/v1/messaging/suppressions',
        body: input,
        schema: z.unknown(),
      }),

    deleteMessagingSuppression: (id: string) =>
      request({
        method: 'DELETE',
        path: `/v1/messaging/suppressions/${id}`,
        schema: z.unknown(),
      }),

    // ─── Conexão do WhatsApp (MOD-CRM-01) ───────────────────────────────────
    //
    // `connect` e `qr` devolvem `qrCode`; `getWhatsappConnection` nunca devolve — o QR
    // vence em cerca de um minuto do lado do provedor, e um QR guardado é um QR morto.

    getWhatsappConnection: () =>
      request({
        method: 'GET',
        path: '/v1/messaging/whatsapp',
        schema: WhatsappConnectionSchema,
      }),

    connectWhatsapp: () =>
      request({
        method: 'POST',
        path: '/v1/messaging/whatsapp/connect',
        schema: WhatsappConnectionSchema,
      }),

    refreshWhatsappQrCode: () =>
      request({
        method: 'POST',
        path: '/v1/messaging/whatsapp/qr',
        schema: WhatsappConnectionSchema,
      }),

    /** Recuperação: apaga a instância no provedor e cria outra, com identidade nova. */
    recreateWhatsapp: () =>
      request({
        method: 'POST',
        path: '/v1/messaging/whatsapp/recreate',
        schema: WhatsappConnectionSchema,
      }),

    disconnectWhatsapp: () =>
      request({
        method: 'DELETE',
        path: '/v1/messaging/whatsapp',
        schema: WhatsappConnectionSchema,
      }),

    listAutomations: () =>
      request({
        method: 'GET',
        path: '/v1/crm/automations',
        schema: z.object({ data: z.array(AutomationResponseSchema) }),
      }),

    updateAutomation: (key: string, input: UpdateAutomationInput) =>
      request({
        method: 'PATCH',
        path: `/v1/crm/automations/${key}`,
        body: input,
        schema: AutomationResponseSchema,
      }),

    // ─── MOD-SITE — o site do estabelecimento ──────────────────────────────

    getSiteSettings: () =>
      request({ method: 'GET', path: '/v1/site/settings', schema: SiteSettingsSchema }),

    updateSiteSettings: (patch: SiteContentPatch) =>
      request({
        method: 'PATCH',
        path: '/v1/site/settings',
        body: patch,
        schema: SiteSettingsSchema,
      }),

    publishSite: () =>
      request({ method: 'POST', path: '/v1/site/publish', schema: SiteSettingsSchema }),

    unpublishSite: () =>
      request({ method: 'POST', path: '/v1/site/unpublish', schema: SiteSettingsSchema }),

    /** A página montada mesmo despublicada, mais o que falta para publicar. */
    getSitePreview: () =>
      request({ method: 'GET', path: '/v1/site/preview', schema: SitePreviewSchema }),

    listSitePhotos: () =>
      request({
        method: 'GET',
        path: '/v1/site/photos',
        schema: z.object({ items: z.array(SitePhotoSchema) }),
      }),

    uploadSitePhoto: (form: FormData) => upload('/v1/site/photos', form, SitePhotoSchema),

    updateSitePhoto: (id: string, patch: SitePhotoPatch) =>
      request({
        method: 'PATCH',
        path: `/v1/site/photos/${id}`,
        body: patch,
        schema: SitePhotoSchema,
      }),

    deleteSitePhoto: (id: string) =>
      request<void>({ method: 'DELETE', path: `/v1/site/photos/${id}` }),

    /**
     * Só o contador da fila, para o sino de pendências. Não decifra nada — ver
     * `SiteLeadCountSchema`.
     */
    countSiteLeads: () =>
      request({
        method: 'GET',
        path: '/v1/site/leads/count',
        schema: SiteLeadCountSchema,
      }),

    listSiteLeads: (status?: SiteLeadStatus) =>
      request({
        method: 'GET',
        path: status ? `/v1/site/leads?status=${status}` : '/v1/site/leads',
        schema: SiteLeadListSchema,
      }),

    updateSiteLead: (id: string, patch: SiteLeadPatch) =>
      request({
        method: 'PATCH',
        path: `/v1/site/leads/${id}`,
        body: patch,
        schema: SiteLeadSchema,
      }),

    /** Exige `tutor:create` além de `site:read_leads`: a ficha é criada pelo MOD-TUTOR. */
    convertSiteLead: (id: string, tutorId: string) =>
      request({
        method: 'POST',
        path: `/v1/site/leads/${id}/convert`,
        body: { tutorId },
        schema: SiteLeadSchema,
      }),
  }
}

/**
 * Filtros do histórico. Datas em ISO porque vêm da URL do painel, não de um `Date` —
 * quem monta o link é o navegador do atendente, e o Zod da rota faz a coerção.
 */
export type MessageFilters = {
  page?: number
  limit?: number
  status?: MessageStatus
  channel?: MessageChannel
  category?: MessageCategory
  templateKey?: string
  from?: string
  to?: string
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
  PaginatedTaxiRides,
  TaxiBoard,
  TaxiQuote,
  TaxiRideResponse,
  TaxiRoute,
  TaxiSettings,
  TaxiVehicleResponse,
  TaxiZoneResponse,
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


/** Um documento binário já lido, pronto para ser repassado pela rota do Next. */
export interface DownloadedFile {
  bytes: Uint8Array
  contentType: string
  filename: string
}

/**
 * O nome do arquivo, tirado do `content-disposition`.
 *
 * Quem escolhe o nome é o serviço, porque é ele que sabe o que foi impresso — a data-base
 * do relatório de contas a receber, o período do relatório diário. O cliente só repassa;
 * inventar o nome aqui daria dois lugares para mantê-lo em acordo.
 *
 * `filename*` (RFC 5987) vem antes porque, quando existe, é o codificado — e é o que os
 * navegadores preferem.
 */
function filenameFrom(header: string | null): string | null {
  if (!header) return null

  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // Header malformado não vale uma exceção: cai no nome padrão de quem chamou.
    }
  }

  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim() ?? null
}
