import {
  AllergyCheckSchema,
  CreateAllergySchema,
  CreateMedicalAlertSchema,
  RecordTemperamentSchema,
  UpdateAllergySchema,
  UpdateMedicalAlertSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from '../../auth/context.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from './actor.js'
import { petAlerts } from './alerts.js'
import {
  checkAllergies,
  createAllergy,
  createMedicalAlert,
  getSafetyRecord,
  getTemperamentHistory,
  recordTemperament,
  updateAllergy,
  updateMedicalAlert,
} from './service.js'

/**
 * Rotas do prontuário de segurança (PRD prontuario_04 §5).
 *
 * A matriz do §9 vira `requirePermission` em cada rota, e ela é mais fina do que
 * parece: `record:read_alerts` é de **todo mundo** que encosta no animal, inclusive
 * o motorista, porque quem abre a caixa de transporte precisa saber que o pet morde.
 * Já desativar uma alergia é `record:write` — do administrador e do veterinário.
 */

interface PetParams {
  petId: string
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

export async function registerRecordRoutes(app: FastifyInstance): Promise<void> {
  // ─── Visão consolidada ─────────────────────────────────────────────────────

  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/safety-record',
    { preHandler: requirePermission('record:read_alerts') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getSafetyRecord(auth.tenantId, request.params.petId)
    },
  )

  /** Só a lista agregada — é o que o pet-service e a agenda consomem. */
  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/alerts',
    { preHandler: requirePermission('record:read_alerts') },
    async (request) => {
      const auth = requireTenantContext(request)
      return petAlerts(auth.tenantId, request.params.petId)
    },
  )

  // ─── Alergias (MOD-PRONT-03) ───────────────────────────────────────────────

  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/allergies',
    { preHandler: requirePermission('record:read_alerts') },
    async (request) => {
      const auth = requireTenantContext(request)
      return (await getSafetyRecord(auth.tenantId, request.params.petId)).allergies
    },
  )

  app.post<{ Params: PetParams }>(
    '/v1/pets/:petId/allergies',
    {
      preHandler: requirePermission(
        'record:write_alerts',
        'Seu perfil não permite registrar alergias',
      ),
    },
    async (request, reply) => {
      const input = parseInput(CreateAllergySchema, request.body)
      const allergy = await createAllergy(actorOf(request), request.params.petId, input)
      return reply.status(201).send(allergy)
    },
  )

  /**
   * Editar e desativar exigem `record:write` — do administrador e do veterinário.
   * A recepção registra o que o tutor conta; retirar um alerta de segurança do ar
   * é decisão clínica.
   */
  app.patch<{ Params: PetParams & { id: string } }>(
    '/v1/pets/:petId/allergies/:id',
    { preHandler: requirePermission('record:write', 'Somente o veterinário altera alergias') },
    async (request) => {
      const patch = parseInput(UpdateAllergySchema, request.body)
      return updateAllergy(actorOf(request), request.params.petId, request.params.id, patch)
    },
  )

  /** RN-03/RN-04: o MOD-AGENDA pergunta antes de gravar o agendamento. */
  app.post<{ Params: PetParams }>(
    '/v1/pets/:petId/allergy-check',
    { preHandler: requirePermission('record:read_alerts') },
    async (request) => {
      const auth = requireTenantContext(request)
      const input = parseInput(AllergyCheckSchema, request.body)
      return checkAllergies(auth.tenantId, request.params.petId, input.serviceIds)
    },
  )

  // ─── Temperamento (MOD-PRONT-04) ───────────────────────────────────────────

  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/temperament',
    { preHandler: requirePermission('record:read_alerts') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getTemperamentHistory(auth.tenantId, request.params.petId)
    },
  )

  /**
   * `record:write_notes`: quem observa o comportamento é quem manuseia o animal —
   * banhista e tosador inclusive. Exigir veterinário aqui faria a observação mais
   * valiosa (a de quem estava segurando o pet) nunca ser registrada.
   */
  app.post<{ Params: PetParams }>(
    '/v1/pets/:petId/temperament',
    {
      preHandler: requirePermission(
        'record:write_notes',
        'Seu perfil não permite registrar temperamento',
      ),
    },
    async (request, reply) => {
      const input = parseInput(RecordTemperamentSchema, request.body)
      const temperament = await recordTemperament(actorOf(request), request.params.petId, input)
      return reply.status(201).send(temperament)
    },
  )

  // ─── Alertas médicos (MOD-PRONT-05) ────────────────────────────────────────

  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/medical-alerts',
    { preHandler: requirePermission('record:read_alerts') },
    async (request) => {
      const auth = requireTenantContext(request)
      return (await getSafetyRecord(auth.tenantId, request.params.petId)).medicalAlerts
    },
  )

  app.post<{ Params: PetParams }>(
    '/v1/pets/:petId/medical-alerts',
    {
      preHandler: requirePermission(
        'record:write_alerts',
        'Seu perfil não permite registrar alertas médicos',
      ),
    },
    async (request, reply) => {
      const input = parseInput(CreateMedicalAlertSchema, request.body)
      const alert = await createMedicalAlert(actorOf(request), request.params.petId, input)
      return reply.status(201).send(alert)
    },
  )

  app.patch<{ Params: PetParams & { id: string } }>(
    '/v1/pets/:petId/medical-alerts/:id',
    {
      preHandler: requirePermission('record:write', 'Somente o veterinário altera alertas médicos'),
    },
    async (request) => {
      const patch = parseInput(UpdateMedicalAlertSchema, request.body)
      return updateMedicalAlert(actorOf(request), request.params.petId, request.params.id, patch)
    },
  )
}
