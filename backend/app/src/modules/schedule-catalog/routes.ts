import {
  CalendarBlockQuerySchema,
  CreateCalendarBlockSchema,
  CreateProfessionalSchema,
  CreateServiceSchema,
  ReplaceScheduleSchema,
  ReplaceServicePricingSchema,
  UpdateProfessionalSchema,
  UpdateServiceSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission, requireTenantContext } from '../scheduling/auth.js'
import { parseInput } from '../scheduling/validate.js'
import type { ActorContext } from './actor.js'
import { createBlock, deleteBlock, listBlocks } from './blocks.js'
import {
  createProfessional,
  listProfessionals,
  replaceSchedule,
  updateProfessional,
} from './professionals.js'
import {
  createService,
  deleteService,
  listServices,
  replaceServicePricing,
  resolvePricing,
  updateService,
} from './service.js'

/**
 * Rotas do catálogo da agenda (PRD agenda_operacao_06 §5).
 *
 * A matriz do §9 dá **uma** linha exclusiva ao TENANT_ADMIN — "Gerir serviços e
 * jornadas" — e é por isso que toda escrita aqui exige `schedule:manage_catalog`,
 * separada de `schedule:write_all`: a recepção agenda o dia inteiro, mas não decide
 * quanto custa um banho nem quem trabalha no sábado.
 *
 * A leitura é mais larga: o seletor de serviços aparece para quem agenda, e a lista
 * de profissionais para quem monta o dia.
 */

const IdParamSchema = z.object({ id: z.uuid() })
const ListQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})
const PricingQuerySchema = z.object({ sizeId: z.uuid() })

function actorFrom(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId ?? undefined,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  }
}

const MANAGE = { preHandler: requirePermission('schedule:manage_catalog') }
const READ = { preHandler: requirePermission('schedule:read_all') }

export async function registerScheduleCatalogRoutes(app: FastifyInstance): Promise<void> {
  // ─── Serviços (MOD-AGENDA-01) ──────────────────────────────────────────────

  app.get('/v1/services', READ, async (request) => {
    const query = parseInput(ListQuerySchema, request.query)
    return listServices(actorFrom(request), query.includeInactive)
  })

  app.post('/v1/services', MANAGE, async (request, reply) => {
    const input = parseInput(CreateServiceSchema, request.body)
    const service = await createService(actorFrom(request), input)
    return reply.status(201).send(service)
  })

  app.patch('/v1/services/:id', MANAGE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(UpdateServiceSchema, request.body)
    return updateService(actorFrom(request), id, input)
  })

  app.delete('/v1/services/:id', MANAGE, async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await deleteService(actorFrom(request), id)
    return reply.status(204).send()
  })

  app.put('/v1/services/:id/pricing', MANAGE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(ReplaceServicePricingSchema, request.body)
    return replaceServicePricing(actorFrom(request), id, input.pricing)
  })

  /**
   * Preço e duração resolvidos para um porte. É o AC-02 exposto: a fatia 2 chama
   * isto ao montar o agendamento, e a tela de catálogo chama para avisar que falta
   * preencher um porte antes de alguém descobrir no balcão.
   */
  app.get('/v1/services/:id/pricing', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const { sizeId } = parseInput(PricingQuerySchema, request.query)
    return resolvePricing(actorFrom(request), id, sizeId)
  })

  // ─── Profissionais (MOD-AGENDA-02) ─────────────────────────────────────────

  app.get('/v1/professionals', READ, async (request) => {
    const query = parseInput(ListQuerySchema, request.query)
    return listProfessionals(actorFrom(request), query.includeInactive)
  })

  app.post('/v1/professionals', MANAGE, async (request, reply) => {
    const input = parseInput(CreateProfessionalSchema, request.body)
    const professional = await createProfessional(actorFrom(request), input)
    return reply.status(201).send(professional)
  })

  app.patch('/v1/professionals/:id', MANAGE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(UpdateProfessionalSchema, request.body)
    return updateProfessional(actorFrom(request), id, input)
  })

  app.put('/v1/professionals/:id/schedule', MANAGE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(ReplaceScheduleSchema, request.body)
    return replaceSchedule(actorFrom(request), id, input.windows)
  })

  // ─── Bloqueios (MOD-AGENDA-03) ─────────────────────────────────────────────

  app.get('/v1/calendar-blocks', READ, async (request) => {
    const query = parseInput(CalendarBlockQuerySchema, request.query)
    return listBlocks(actorFrom(request), query)
  })

  app.post('/v1/calendar-blocks', MANAGE, async (request, reply) => {
    const input = parseInput(CreateCalendarBlockSchema, request.body)
    const block = await createBlock(actorFrom(request), input)
    return reply.status(201).send(block)
  })

  app.delete('/v1/calendar-blocks/:id', MANAGE, async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await deleteBlock(actorFrom(request), id)
    return reply.status(204).send()
  })
}
