import {
  CalendarBlockCreatedSchema,
  CalendarBlockResponseSchema,
  DayViewSchema,
  MovementResponseSchema,
  BookingSourcesSchema,
  NoShowReportSchema,
  ProfessionalResponseSchema,
  ProfessionalWithWarningsSchema,
  ResolvedPricingSchema,
  ServiceResponseSchema,
  type CreateCalendarBlockInput,
  type CreateProfessionalInput,
  type CreateServiceInput,
  type ScheduleWindow,
  type ServicePricingItem,
  type UpdateProfessionalInput,
  type UpdateServiceInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function schedulingEndpoints({ request }: Transport) {
  return {
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

    /** As faltas do período, contadas pela data do atendimento, e o valor que não entrou. */
    getNoShows: (query: { days?: number } = {}) =>
      request({
        method: 'GET',
        path: `/v1/agenda/reports/no-shows${toQueryString(query)}`,
        schema: NoShowReportSchema,
      }),
  }
}
