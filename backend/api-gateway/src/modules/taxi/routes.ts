import {
  AssignTaxiRideSchema,
  AvailableDriversQuerySchema,
  CancelTaxiRideSchema,
  CreateTaxiRidesSchema,
  FailTaxiRideSchema,
  ListTaxiRidesQuerySchema,
  TaxiDayQuerySchema,
  TaxiOperationReportQuerySchema,
  TaxiQuoteQuerySchema,
  TaxiStatusTransitionSchema,
  TaxiVehicleSchema,
  TaxiZoneSchema,
  UpdateTaxiRideSchema,
  UpdateTaxiSettingsSchema,
  UpdateTaxiVehicleSchema,
  UpdateTaxiZoneSchema,
} from '@petshop/shared-types'
import { withTenant } from '@petshop/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { hasPermission, requirePermission, requireTenantContext } from './auth.js'
import { forbidden, notFound } from './errors.js'
import { parseInput } from './validate.js'
import type { ActorContext } from './actor.js'
import { assignRide, updateRide } from './assignment.js'
import { getBoard, getDriverRoute } from './board.js'
import { advanceRide, cancelRide, failRide } from './transitions.js'
import { findAvailableDrivers } from './drivers.js'
import { resolvePrice } from './pricing.js'
import { taxiOperationReport } from './reports.js'
import { createRides } from './rides.js'
import { getRide, listRides, type RideScope } from './queries.js'
import { assertEnabled, getSettings, readSettings, updateSettings } from './settings.js'
import { createVehicle, listVehicles, updateVehicle } from './vehicles.js'
import { createZone, deleteZone, listZones, updateZone } from './zones.js'

/**
 * Rotas do Taxi Dog (PRD taxi_dog_07 §5).
 *
 * O corte de permissão do §9 tem duas sutilezas que vale ler:
 *
 * **`taxi:operate` significa coisas diferentes por papel.** Para a recepção e o
 * admin, é "opere qualquer corrida"; para o motorista, é "opere as **suas**"
 * (RN-19). O escopo não vem do cliente — sai de `driverIdOf`, que resolve o
 * `professionals` do usuário autenticado. Um motorista que passe `?driverId=` de um
 * colega continua vendo só as próprias corridas.
 *
 * **Configurar não é operar.** Zonas, frota, configuração e preço manual exigem
 * `taxi:configure`, que só o TENANT_ADMIN tem. Quem dirige a van não redefine o
 * preço da corrida.
 */

interface IdParams {
  id: string
}

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

/**
 * O `professionals.id` do usuário autenticado, quando ele é motorista.
 *
 * Nulo para quem opera tudo. É este valor — e não um parâmetro da requisição — que
 * limita o motorista às próprias corridas.
 */
async function driverIdOf(request: FastifyRequest): Promise<string | null> {
  const auth = requireTenantContext(request)
  if (hasPermission(request, 'schedule:write_all') || hasPermission(request, 'taxi:configure')) {
    return null
  }
  if (!auth.userId) return null

  return withTenant(auth.tenantId, async (tx) => {
    const professional = await tx.professional.findFirst({
      where: { userId: auth.userId, deletedAt: null },
      select: { id: true, roleKey: true },
    })
    return professional?.roleKey === 'DRIVER' ? professional.id : null
  })
}

async function scopeOf(request: FastifyRequest): Promise<RideScope> {
  const driverId = await driverIdOf(request)
  return driverId ? { driverId } : {}
}

export async function registerTaxiRoutes(app: FastifyInstance): Promise<void> {
  // ─── Configuração (MOD-TAXI-06 e §4) ───────────────────────────────────────

  /**
   * A leitura da configuração abre com `taxi:operate` de propósito: a recepção
   * precisa saber se o módulo está ligado e qual a janela padrão para montar a tela,
   * mesmo sem poder editar nada.
   */
  app.get(
    '/v1/taxi/settings',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => getSettings(actorOf(request)),
  )

  app.patch(
    '/v1/taxi/settings',
    { preHandler: requirePermission('taxi:configure') },
    async (request) =>
      updateSettings(actorOf(request), parseInput(UpdateTaxiSettingsSchema, request.body)),
  )

  // ─── Zonas ─────────────────────────────────────────────────────────────────

  app.get(
    '/v1/taxi/zones',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => ({ items: await listZones(actorOf(request)) }),
  )

  app.post(
    '/v1/taxi/zones',
    { preHandler: requirePermission('taxi:configure') },
    async (request, reply) => {
      const zone = await createZone(actorOf(request), parseInput(TaxiZoneSchema, request.body))
      return reply.status(201).send(zone)
    },
  )

  app.patch<{ Params: IdParams }>(
    '/v1/taxi/zones/:id',
    { preHandler: requirePermission('taxi:configure') },
    async (request) =>
      updateZone(
        actorOf(request),
        request.params.id,
        parseInput(UpdateTaxiZoneSchema, request.body),
      ),
  )

  app.delete<{ Params: IdParams }>(
    '/v1/taxi/zones/:id',
    { preHandler: requirePermission('taxi:configure') },
    async (request, reply) => {
      await deleteZone(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )

  // ─── Frota ─────────────────────────────────────────────────────────────────

  app.get(
    '/v1/taxi/vehicles',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => ({ items: await listVehicles(actorOf(request)) }),
  )

  app.post(
    '/v1/taxi/vehicles',
    { preHandler: requirePermission('taxi:configure') },
    async (request, reply) => {
      const vehicle = await createVehicle(
        actorOf(request),
        parseInput(TaxiVehicleSchema, request.body),
      )
      return reply.status(201).send(vehicle)
    },
  )

  app.patch<{ Params: IdParams }>(
    '/v1/taxi/vehicles/:id',
    { preHandler: requirePermission('taxi:configure') },
    async (request) =>
      updateVehicle(
        actorOf(request),
        request.params.id,
        parseInput(UpdateTaxiVehicleSchema, request.body),
      ),
  )

  // ─── Preço sem criar nada ──────────────────────────────────────────────────

  /**
   * "Quanto custa buscar aqui?" antes de existir agendamento. É consulta pura: o
   * Portal e o agente de IA precisam responder isso sem deixar corrida-lixo no
   * painel a cada pergunta.
   */
  app.get(
    '/v1/taxi/quote',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => {
      const actor = actorOf(request)
      const query = parseInput(TaxiQuoteQuerySchema, request.query)

      return withTenant(actor.tenantId, async (tx) => {
        const settings = await assertEnabled(tx, actor.tenantId)
        const price = await resolvePrice(tx, settings, query.zipCode)
        return {
          zipCode: query.zipCode,
          priceCents: price.priceCents,
          priceSource: price.source,
          zone: price.zoneId ? { id: price.zoneId, name: price.zoneName } : null,
        }
      })
    },
  )

  // ─── Motoristas disponíveis ────────────────────────────────────────────────

  app.get(
    '/v1/taxi/drivers/available',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => {
      const actor = actorOf(request)
      const query = parseInput(AvailableDriversQuerySchema, request.query)
      return withTenant(actor.tenantId, async (tx) => ({
        items: await findAvailableDrivers(tx, query.windowStartsAt, query.windowEndsAt),
      }))
    },
  )

  // ─── Corridas ──────────────────────────────────────────────────────────────

  app.get(
    '/v1/taxi/rides',
    { preHandler: requirePermission('taxi:operate') },
    async (request) =>
      listRides(
        actorOf(request),
        parseInput(ListTaxiRidesQuerySchema, request.query),
        await scopeOf(request),
      ),
  )

  app.get<{ Params: IdParams }>(
    '/v1/taxi/rides/:id',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => getRide(actorOf(request), request.params.id, await scopeOf(request)),
  )

  /**
   * Criar corrida é da recepção e do admin, nunca do motorista: quem promete a
   * janela ao tutor é quem atende o balcão. O motorista tem `taxi:operate` para
   * **executar**, e o escopo dele barra o resto.
   */
  app.post(
    '/v1/taxi/rides',
    { preHandler: requirePermission('taxi:operate') },
    async (request, reply) => {
      if (await driverIdOf(request)) {
        throw forbidden('Motoristas não criam corridas — peça à recepção')
      }
      const rides = await createRides(
        actorOf(request),
        parseInput(CreateTaxiRidesSchema, request.body),
        { canOverridePrice: hasPermission(request, 'taxi:configure') },
      )
      return reply.status(201).send({ items: rides })
    },
  )

  app.patch<{ Params: IdParams }>(
    '/v1/taxi/rides/:id',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => {
      if (await driverIdOf(request)) {
        throw forbidden('Motoristas não alteram a janela nem o endereço da corrida')
      }
      return updateRide(
        actorOf(request),
        request.params.id,
        parseInput(UpdateTaxiRideSchema, request.body),
      )
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/taxi/rides/:id/assign',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => {
      if (await driverIdOf(request)) {
        throw forbidden('Motoristas não se atribuem corridas')
      }
      return assignRide(
        actorOf(request),
        request.params.id,
        parseInput(AssignTaxiRideSchema, request.body),
      )
    },
  )

  // ─── Execução (MOD-TAXI-04 e 09) ───────────────────────────────────────────

  /**
   * A transição que o motorista aperta na rua.
   *
   * É a **única** escrita que o papel DRIVER faz, e o escopo garante que seja só na
   * corrida dele (RN-19). `occurredAt` aceita retroação de até 6h porque o sinal cai
   * — e a hora real do fato vale mais que a hora em que o celular reconectou.
   */
  app.post<{ Params: IdParams }>(
    '/v1/taxi/rides/:id/status',
    { preHandler: requirePermission('taxi:operate') },
    async (request) =>
      advanceRide(
        actorOf(request),
        request.params.id,
        parseInput(TaxiStatusTransitionSchema, request.body),
        (await driverIdOf(request)) ?? undefined,
      ),
  )

  /** AC-02 de MOD-TAXI-09: ninguém em casa. O agendamento **não** cai junto. */
  app.post<{ Params: IdParams }>(
    '/v1/taxi/rides/:id/fail',
    { preHandler: requirePermission('taxi:operate') },
    async (request) =>
      failRide(
        actorOf(request),
        request.params.id,
        parseInput(FailTaxiRideSchema, request.body),
        (await driverIdOf(request)) ?? undefined,
      ),
  )

  app.post<{ Params: IdParams }>(
    '/v1/taxi/rides/:id/cancel',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => {
      // Cancelar é decisão comercial, não de execução: quem cancela fala com o tutor.
      if (await driverIdOf(request)) {
        throw forbidden('Motoristas não cancelam corridas — registre a falha ou avise a recepção')
      }
      return cancelRide(
        actorOf(request),
        request.params.id,
        parseInput(CancelTaxiRideSchema, request.body),
      )
    },
  )

  // ─── Painel e rota (MOD-TAXI-07) ───────────────────────────────────────────

  app.get(
    '/v1/taxi/board',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => {
      if (await driverIdOf(request)) {
        throw forbidden('Use a sua rota em /v1/taxi/my-route')
      }
      const query = parseInput(TaxiDayQuerySchema, request.query)
      return getBoard(actorOf(request), query.date)
    },
  )

  /**
   * A rota do motorista autenticado.
   *
   * Não aceita `driverId` como parâmetro — nem para o admin. Quem quer ver a rota de
   * outra pessoa usa o painel, que já agrupa por motorista. Aceitar o parâmetro aqui
   * abriria a resposta com telefone e endereço decifrados a um filtro que viria do
   * cliente (§9).
   */
  // ─── Relatório ─────────────────────────────────────────────────────────────

  /**
   * Como o leva-e-traz andou — a faixa do Taxi Dog no painel do Início.
   *
   * `taxi:configure`, e não o `taxi:operate` que abre o resto do módulo. Os três
   * números falam de janela mal dimensionada e de frota pequena demais, que são as
   * duas decisões de quem configura; para o motorista, seriam a nota da prova dele
   * exposta na entrada.
   */
  app.get(
    '/v1/taxi/reports/operation',
    { preHandler: requirePermission('taxi:configure') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(TaxiOperationReportQuerySchema, request.query)
      return taxiOperationReport(auth.tenantId, query.days)
    },
  )

  app.get(
    '/v1/taxi/my-route',
    { preHandler: requirePermission('taxi:operate') },
    async (request) => {
      const driverId = await driverIdOf(request)
      if (!driverId) {
        throw notFound('Este usuário não é um motorista cadastrado')
      }
      const query = parseInput(TaxiDayQuerySchema, request.query)
      return getDriverRoute(actorOf(request), driverId, query.date)
    },
  )
}

export { readSettings }
