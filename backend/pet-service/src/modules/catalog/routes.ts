import {
  BreedVisibilitySchema,
  CreateBreedSchema,
  UpdateBreedSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from '../../auth/context.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from '../pets/actor.js'
import {
  createBreed,
  deleteBreed,
  listManagedBreeds,
  setBreedVisibility,
  updateBreed,
} from './breeds.js'
import { listBreeds, listCoats, listSizes, listSpecies } from './service.js'

/**
 * Catálogo de domínio, somente leitura (PRD pets_03 §5).
 *
 * O §5 marca estes endpoints como "Todos", e `pet:read` é a permissão que todo
 * perfil operacional tem — inclusive banhista e veterinário. Não é rota pública: sem
 * a assinatura do gateway nada passa, e sem tenant no contexto o RLS devolveria só o
 * catálogo global, escondendo as raças do estabelecimento.
 *
 * A escrita é outra história: `pet:manage_catalog` é só do TENANT_ADMIN (§9), porque
 * uma raça criada errado contamina relatório e preço de todo mundo no tenant.
 */

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/species', { preHandler: requirePermission('pet:read') }, async (request) => {
    const auth = requireTenantContext(request)
    return listSpecies(auth.tenantId)
  })

  app.get<{ Params: { id: string } }>(
    '/v1/species/:id/breeds',
    { preHandler: requirePermission('pet:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listBreeds(auth.tenantId, request.params.id)
    },
  )

  app.get('/v1/sizes', { preHandler: requirePermission('pet:read') }, async (request) => {
    const auth = requireTenantContext(request)
    return listSizes(auth.tenantId)
  })

  app.get('/v1/coats', { preHandler: requirePermission('pet:read') }, async (request) => {
    const auth = requireTenantContext(request)
    return listCoats(auth.tenantId)
  })

  // ─── Catálogo de raças do tenant (MOD-PET-03) ──────────────────────────────

  /** A lista da administração: inclui o que está oculto e quantos pets usam cada raça. */
  app.get<{ Querystring: { speciesId?: string } }>(
    '/v1/breeds',
    { preHandler: requirePermission('pet:manage_catalog', 'Seu perfil não gerencia o catálogo') },
    async (request) => {
      const auth = requireTenantContext(request)
      const speciesId = request.query.speciesId
      if (!speciesId) {
        // Sem espécie a lista seria o catálogo inteiro — centenas de raças de todas
        // as espécies, que nenhuma tela usa.
        return []
      }
      return listManagedBreeds(auth.tenantId, speciesId)
    },
  )

  app.post(
    '/v1/breeds',
    { preHandler: requirePermission('pet:manage_catalog', 'Seu perfil não gerencia o catálogo') },
    async (request, reply) => {
      const input = parseInput(CreateBreedSchema, request.body)
      const breed = await createBreed(actorOf(request), input)
      return reply.status(201).send(breed)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/v1/breeds/:id',
    { preHandler: requirePermission('pet:manage_catalog', 'Seu perfil não gerencia o catálogo') },
    async (request) => {
      const patch = parseInput(UpdateBreedSchema, request.body)
      return updateBreed(actorOf(request), request.params.id, patch)
    },
  )

  /** AC-02: a raça global não se edita nem se apaga — some da lista deste tenant. */
  app.patch<{ Params: { id: string } }>(
    '/v1/breeds/:id/visibility',
    { preHandler: requirePermission('pet:manage_catalog', 'Seu perfil não gerencia o catálogo') },
    async (request) => {
      const input = parseInput(BreedVisibilitySchema, request.body)
      return setBreedVisibility(actorOf(request), request.params.id, input.hidden)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/breeds/:id',
    { preHandler: requirePermission('pet:manage_catalog', 'Seu perfil não gerencia o catálogo') },
    async (request, reply) => {
      await deleteBreed(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )
}
