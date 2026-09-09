import {
  CreatePetSchema,
  LinkTutorSchema,
  ListPetsQuerySchema,
  RecordWeightSchema,
  RegisterDeathSchema,
  RevertDeathSchema,
  TransferPetSchema,
  UpdatePetSchema,
  UpdatePetTutorSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from './auth.js'
import { parseInput } from './validate.js'
import type { ActorContext } from './actor.js'
import { registerDeath, revertDeath } from './lifecycle.js'
import { createPet, deletePet, getPet, listPets, revealMicrochip, updatePet } from './service.js'
import { listTransfers, transferPet } from './transfer.js'
import { linkTutor, listPetTutors, unlinkTutor, updatePetTutor } from './tutors.js'
import { listWeights, recordWeight } from './weights.js'

/**
 * Rotas do pet-service (PRD pets_03 §5).
 *
 * A matriz do §9 vira `requirePermission` em cada rota. Nenhum handler confere papel
 * por conta própria: quem decide é a matriz de MOD-IDENT-04, e a negação já sai
 * auditada de lá.
 */

interface PetParams {
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

export async function registerPetRoutes(app: FastifyInstance): Promise<void> {
  // ─── Listagem e busca ──────────────────────────────────────────────────────

  app.get('/v1/pets', { preHandler: requirePermission('pet:read') }, async (request) => {
    const auth = requireTenantContext(request)
    const query = parseInput(ListPetsQuerySchema, request.query)
    return listPets(auth.tenantId, query)
  })

  app.post(
    '/v1/pets',
    { preHandler: requirePermission('pet:create', 'Seu perfil não permite cadastrar pets') },
    async (request, reply) => {
      const input = parseInput(CreatePetSchema, request.body)
      const pet = await createPet(actorOf(request), input)
      return reply.status(201).send(pet)
    },
  )

  // ─── Um pet ────────────────────────────────────────────────────────────────

  app.get<{ Params: PetParams }>(
    '/v1/pets/:id',
    { preHandler: requirePermission('pet:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getPet(auth.tenantId, request.params.id)
    },
  )

  /** Microchip completo, sem máscara. Cada leitura vira `pet.microchip_revealed`. */
  app.get<{ Params: PetParams }>(
    '/v1/pets/:id/sensitive',
    {
      preHandler: requirePermission('pet:update', 'Seu perfil não permite ver o microchip completo'),
    },
    async (request) => revealMicrochip(actorOf(request), request.params.id),
  )

  app.patch<{ Params: PetParams }>(
    '/v1/pets/:id',
    { preHandler: requirePermission('pet:update') },
    async (request) => {
      const patch = parseInput(UpdatePetSchema, request.body)
      return updatePet(actorOf(request), request.params.id, patch)
    },
  )

  app.delete<{ Params: PetParams }>(
    '/v1/pets/:id',
    { preHandler: requirePermission('pet:delete', 'Somente o administrador exclui pets') },
    async (request, reply) => {
      await deletePet(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )

  // ─── Responsáveis (MOD-PET-02) ─────────────────────────────────────────────

  app.get<{ Params: PetParams }>(
    '/v1/pets/:id/tutors',
    { preHandler: requirePermission('pet:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listPetTutors(auth.tenantId, request.params.id)
    },
  )

  app.post<{ Params: PetParams }>(
    '/v1/pets/:id/tutors',
    { preHandler: requirePermission('pet:update') },
    async (request, reply) => {
      const input = parseInput(LinkTutorSchema, request.body)
      const link = await linkTutor(actorOf(request), request.params.id, input)
      return reply.status(201).send(link)
    },
  )

  app.patch<{ Params: PetParams & { linkId: string } }>(
    '/v1/pets/:id/tutors/:linkId',
    { preHandler: requirePermission('pet:update') },
    async (request) => {
      const patch = parseInput(UpdatePetTutorSchema, request.body)
      return updatePetTutor(actorOf(request), request.params.id, request.params.linkId, patch)
    },
  )

  app.delete<{ Params: PetParams & { linkId: string } }>(
    '/v1/pets/:id/tutors/:linkId',
    { preHandler: requirePermission('pet:delete', 'Somente o administrador desvincula responsáveis') },
    async (request, reply) => {
      await unlinkTutor(actorOf(request), request.params.id, request.params.linkId)
      return reply.status(204).send()
    },
  )

  // ─── Transferência de titularidade (MOD-PET-05) ────────────────────────────

  app.post<{ Params: PetParams }>(
    '/v1/pets/:id/transfer',
    {
      preHandler: requirePermission(
        'pet:manage_lifecycle',
        'Somente o administrador transfere a titularidade',
      ),
    },
    async (request) => {
      const input = parseInput(TransferPetSchema, request.body)
      return transferPet(actorOf(request), request.params.id, input)
    },
  )

  app.get<{ Params: PetParams }>(
    '/v1/pets/:id/transfers',
    { preHandler: requirePermission('pet:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listTransfers(auth.tenantId, request.params.id)
    },
  )

  // ─── Histórico de peso (MOD-PET-07) ────────────────────────────────────────

  app.get<{ Params: PetParams }>(
    '/v1/pets/:id/weights',
    { preHandler: requirePermission('pet:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listWeights(auth.tenantId, request.params.id)
    },
  )

  /** `pet:weigh`, e não `pet:update`: o banhista pesa sem poder editar o cadastro (§9). */
  app.post<{ Params: PetParams }>(
    '/v1/pets/:id/weights',
    { preHandler: requirePermission('pet:weigh', 'Seu perfil não permite registrar pesagem') },
    async (request, reply) => {
      const input = parseInput(RecordWeightSchema, request.body)
      const record = await recordWeight(actorOf(request), request.params.id, input)
      return reply.status(201).send(record)
    },
  )

  // ─── Óbito (MOD-PET-08) ────────────────────────────────────────────────────

  app.post<{ Params: PetParams }>(
    '/v1/pets/:id/death',
    { preHandler: requirePermission('pet:update', 'Seu perfil não permite registrar o óbito') },
    async (request) => {
      const input = parseInput(RegisterDeathSchema, request.body)
      return registerDeath(actorOf(request), request.params.id, input)
    },
  )

  app.post<{ Params: PetParams }>(
    '/v1/pets/:id/death/reversal',
    {
      preHandler: requirePermission(
        'pet:manage_lifecycle',
        'Somente o administrador reverte um óbito',
      ),
    },
    async (request) => {
      const input = parseInput(RevertDeathSchema, request.body)
      return revertDeath(actorOf(request), request.params.id, input)
    },
  )
}
