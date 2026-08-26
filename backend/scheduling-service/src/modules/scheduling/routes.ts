import { withTenant } from '@petshop/db'
import {
  AvailabilityQuerySchema,
  CancelAppointmentSchema,
  CheckoutSchema,
  CreateAppointmentSchema,
  CreateRecurrenceSchema,
  DayViewQuerySchema,
  ListAppointmentsQuerySchema,
  RecurrenceScopeSchema,
  RescheduleSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hasPermission, requirePermission, requireTenantContext } from '../../auth/context.js'
import { notFound } from '../../lib/errors.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from '../catalog/actor.js'
import { findAvailability } from './availability.js'
import { createBooking } from './booking.js'
import { resolveItemDuration } from './duration.js'
import { getDayView } from './day-view.js'
import { getAppointment, listAppointments } from './queries.js'
import { createRecurrence, endRecurrence } from './recurrence.js'
import { loadTimezone } from './timezone.js'
import { approve, cancel, checkIn, checkOut, markNoShow, reschedule } from './transitions.js'

/**
 * Rotas do agendamento (PRD agenda_operacao_06 §5).
 *
 * A matriz do §9 dá permissões diferentes para ler, escrever e fazer check-in — e é
 * de propósito: o banhista faz check-in do pet que ele vai lavar, mas não remarca
 * nada; a recepção agenda o dia inteiro, mas não libera crédito.
 */

const IdParamSchema = z.object({ id: z.uuid() })

function actorFrom(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId ?? undefined,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  }
}

const READ = { preHandler: requirePermission('schedule:read_all') }
const WRITE = { preHandler: requirePermission('schedule:write_all') }
const CHECKIN = { preHandler: requirePermission('checkin:manage') }

export async function registerSchedulingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * MOD-AGENDA-11. A duração é calculada para **este** pet antes de varrer a agenda:
   * porte e pelagem mudam o tamanho do buraco necessário, e disponibilidade sem pet
   * seria uma aproximação que a criação depois recusaria.
   */
  app.get('/v1/availability', READ, async (request) => {
    const query = parseInput(AvailabilityQuerySchema, request.query)
    const actor = actorFrom(request)

    return withTenant(actor.tenantId, async (tx) => {
      const pet = await tx.pet.findFirst({
        where: { id: query.petId },
        select: { sizeId: true, coat: { select: { groomingTimeFactor: true } } },
      })
      if (!pet) throw notFound('Pet não encontrado')

      const service = await tx.service.findFirst({
        where: { id: query.serviceId, deletedAt: null, active: true },
        select: { id: true, category: true },
      })
      if (!service) throw notFound('Serviço não encontrado')

      const pricing = await tx.servicePricing.findFirst({
        where: { serviceId: service.id, sizeId: pet.sizeId },
      })
      if (!pricing) {
        throw notFound('Este serviço não tem preço definido para o porte deste pet')
      }

      const durationMin = resolveItemDuration({
        sizeDurationMin: pricing.durationMin,
        coatFactor: pet.coat ? Number(pet.coat.groomingTimeFactor) : null,
        category: service.category,
      })

      // Sem `professionalId`, oferece a agenda de todos os habilitados no serviço.
      const professionals = await tx.professional.findMany({
        where: {
          active: true,
          deletedAt: null,
          services: { some: { serviceId: service.id } },
          ...(query.professionalId ? { id: query.professionalId } : {}),
        },
        select: { id: true, displayName: true },
      })
      const nameById = new Map(professionals.map((p) => [p.id, p.displayName]))

      const result = await findAvailability(tx, {
        professionalIds: professionals.map((p) => p.id),
        durationMin,
        from: new Date(query.from),
        to: new Date(query.to),
      })

      return {
        slots: result.slots.map((slot) => ({
          professionalId: slot.professionalId,
          professionalName: nameById.get(slot.professionalId) ?? '',
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
          durationMin,
          priceCents: Number(pricing.priceCents),
        })),
        nextAvailable: result.nextAvailable?.toISOString() ?? null,
        durationMin,
        priceCents: Number(pricing.priceCents),
        timezone: await loadTimezone(tx),
      }
    })
  })

  app.get('/v1/appointments', READ, async (request) => {
    const query = parseInput(ListAppointmentsQuerySchema, request.query)
    return listAppointments(actorFrom(request), query)
  })

  app.get('/v1/appointments/:id', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getAppointment(actorFrom(request), id)
  })

  app.post('/v1/appointments', WRITE, async (request, reply) => {
    const input = parseInput(CreateAppointmentSchema, request.body)

    const booking = await createBooking(
      actorFrom(request),
      {
        petId: input.petId,
        professionalId: input.professionalId,
        startsAt: new Date(input.startsAt),
        items: input.items,
        notes: input.notes,
        source: input.source,
        acknowledgedAlerts: input.acknowledgedAlerts,
        override: input.override,
      },
      // A capacidade vem da matriz de permissão, não do papel: repetir "é
      // TENANT_ADMIN?" aqui criaria uma segunda fonte de verdade sobre RBAC.
      { canOverrideCredit: hasPermission(request, 'schedule:override_credit') },
    )

    return reply.status(201).send(await getAppointment(actorFrom(request), booking.id))
  })

  app.post('/v1/appointments/:id/checkin', CHECKIN, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await checkIn(actorFrom(request), id)
    return getAppointment(actorFrom(request), id)
  })

  app.post('/v1/appointments/:id/checkout', CHECKIN, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(CheckoutSchema, request.body)
    await checkOut(actorFrom(request), id, input)
    return getAppointment(actorFrom(request), id)
  })

  app.post('/v1/appointments/:id/cancel', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(CancelAppointmentSchema, request.body)
    await cancel(actorFrom(request), id, input)
    return getAppointment(actorFrom(request), id)
  })

  /**
   * Marcar falta é ato de gestão, não de atendimento: quem faz check-in não decide
   * que alguém faltou. O job `no-show-sweeper` chama o mesmo caminho.
   */
  app.post('/v1/appointments/:id/no-show', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await markNoShow(actorFrom(request), id)
    return getAppointment(actorFrom(request), id)
  })

  /**
   * AC-04 de MOD-AGENDA-08. Devolve o **novo** agendamento: é para ele que a tela
   * navega, e o antigo já é histórico no instante da resposta.
   */
  app.post('/v1/appointments/:id/reschedule', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(RescheduleSchema, request.body)

    const result = await reschedule(
      actorFrom(request),
      id,
      { startsAt: new Date(input.startsAt), professionalId: input.professionalId, reason: input.reason },
      { canOverrideCredit: hasPermission(request, 'schedule:override_credit') },
    )

    return {
      ...(await getAppointment(actorFrom(request), result.newAppointmentId)),
      rescheduleCount: result.rescheduleCount,
    }
  })

  /** AC-03 de MOD-AGENDA-06: a recepção decide a fila do Portal. */
  app.post('/v1/appointments/:id/approve', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await approve(actorFrom(request), id)
    return getAppointment(actorFrom(request), id)
  })

  // ─── Visão do dia (MOD-AGENDA-09) ────────────────────────────────────────

  app.get('/v1/agenda/day', READ, async (request) => {
    const query = parseInput(DayViewQuerySchema, request.query)
    const actor = actorFrom(request)

    // RN-19: o fuso é do tenant. "Hoje" em Manaus não é "hoje" em São Paulo.
    const timezone = await withTenant(actor.tenantId, loadTimezone)

    return getDayView(actor, query.date, timezone)
  })

  // ─── Recorrência (MOD-AGENDA-05) ─────────────────────────────────────────

  app.post('/v1/recurrences', WRITE, async (request, reply) => {
    const input = parseInput(CreateRecurrenceSchema, request.body)
    const result = await createRecurrence(actorFrom(request), {
      petId: input.petId,
      professionalId: input.professionalId,
      serviceIds: input.serviceIds,
      startsAt: new Date(input.startsAt),
      rrule: input.rrule,
      until: input.until ? new Date(input.until) : undefined,
    })
    return reply.status(201).send(result)
  })

  app.delete('/v1/recurrences/:id', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const scope = parseInput(
      z.object({ scope: RecurrenceScopeSchema.default('THIS_AND_FUTURE') }),
      request.query,
    )
    return endRecurrence(actorFrom(request), id, scope.scope)
  })
}
