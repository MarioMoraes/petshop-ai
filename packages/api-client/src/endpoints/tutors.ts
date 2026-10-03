import {
  AddressResponseSchema,
  CepLookupSchema,
  CheckDuplicatesResultSchema,
  ConsentsResponseSchema,
  DeletionRequestCountSchema,
  DeletionRequestListResponseSchema,
  DeletionRequestResponseSchema,
  PaginatedTutorsSchema,
  PortalAdoptionSchema,
  PortfolioQualitySchema,
  TagSchema,
  TutorDetailSchema,
  TutorOverviewSchema,
  TutorSensitiveSchema,
  type AddressInput,
  type AnonymizeTutorInput,
  type CreateDeletionRequestInput,
  type DeletionRequestListQuery,
  type ResolveDeletionRequestInput,
  type CheckDuplicatesInput,
  type CreateTagInput,
  type CreateTutorInput,
  type ListTutorsQuery,
  type MergeTutorInput,
  type UpdateAddressInput,
  type UpdateConsentsInput,
  type UpdateTutorInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function tutorEndpoints({ request }: Transport) {
  return {
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

    /** Cadastros completos e opt-in de marketing no WhatsApp, sobre a carteira ativa. */
    getPortfolioQuality: () =>
      request({
        method: 'GET',
        path: '/v1/tutors/reports/portfolio',
        schema: PortfolioQualitySchema,
      }),

    createTutor: (input: CreateTutorInput) =>
      request({ method: 'POST', path: '/v1/tutors', body: input, schema: TutorDetailSchema }),

    updateTutor: (id: string, patch: UpdateTutorInput) =>
      request({
        method: 'PATCH',
        path: `/v1/tutors/${id}`,
        body: patch,
        schema: TutorDetailSchema,
      }),

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

    // ─── Pedidos de exclusão de dados (LGPD art. 18, V) ────────────────────

    /**
     * A fila da equipe. Gate `tutor:delete` no serviço, o mesmo da anonimização.
     *
     * **Responder um pedido não apaga a ficha**: quem anonimiza continua sendo
     * `anonymizeTutor`, com as travas de débito aberto e agenda futura que ele tem.
     */
    listDeletionRequests: (query: Partial<DeletionRequestListQuery> = {}) =>
      request({
        method: 'GET',
        path: `/v1/tutors/deletion-requests${toQueryString(query)}`,
        schema: DeletionRequestListResponseSchema,
      }),

    /** Só o número, para o sino. Ler pela listagem traria nome e saldo de cada ficha. */
    countDeletionRequests: () =>
      request({
        method: 'GET',
        path: '/v1/tutors/deletion-requests/count',
        schema: DeletionRequestCountSchema,
      }),

    resolveDeletionRequest: (id: string, input: ResolveDeletionRequestInput) =>
      request({
        method: 'POST',
        path: `/v1/tutors/deletion-requests/${id}/resolve`,
        body: input,
        schema: DeletionRequestResponseSchema,
      }),

    /** O balcão registra o pedido que o tutor fez por telefone. Gate `tutor:update`. */
    requestTutorDeletion: (id: string, input: CreateDeletionRequestInput) =>
      request({
        method: 'POST',
        path: `/v1/tutors/${id}/deletion-request`,
        body: input,
        schema: DeletionRequestResponseSchema,
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

    listTags: () => request({ method: 'GET', path: '/v1/tutors/tags', schema: z.array(TagSchema) }),

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
  }
}
