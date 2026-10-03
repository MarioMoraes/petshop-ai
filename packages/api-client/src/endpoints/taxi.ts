import {
  AppointmentResponseSchema,
  AvailabilityResponseSchema,
  NewPortalBookingsSchema,
  PendingApprovalsSchema,
  AvailableTaxiDriverSchema,
  ClosedTaxiRideSchema,
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
  type AssignTaxiRideInput,
  type CancelTaxiRideInput,
  type CreateTaxiRidesInput,
  type FailTaxiRideInput,
  type TaxiStatusTransitionInput,
  type TaxiVehicleInput,
  type TaxiZoneInput,
  type UpdateTaxiRideInput,
  type UpdateTaxiSettingsInput,
  type CreateAppointmentInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function taxiEndpoints({ request }: Transport) {
  return {
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

    /**
     * O agendamento que o tutor marcou no Portal e a equipe ainda não viu.
     *
     * `since` é a marca de lido de quem pergunta, que vem de `/v1/me`. Ausente, a
     * agenda conta a janela inteira de novidade — que tem teto lá, e não aqui.
     */
    countNewPortalBookings: (query: { since?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/appointments/portal-new-count${toQueryString(query)}`,
        schema: NewPortalBookingsSchema,
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

    checkOutAppointment: (
      id: string,
      input: {
        idempotencyKey: string
        weightKg?: number
        notes?: string
        extraItems?: { serviceId: string }[]
      },
    ) =>
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
  }
}
