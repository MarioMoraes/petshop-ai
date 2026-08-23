import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from '../../auth/context.js'
import { listBreeds, listCoats, listSizes, listSpecies } from './service.js'

/**
 * Catálogo de domínio, somente leitura (PRD pets_03 §5).
 *
 * O §5 marca estes endpoints como "Todos", e `pet:read` é a permissão que todo
 * perfil operacional tem — inclusive banhista e veterinário. Não é rota pública: sem
 * a assinatura do gateway nada passa, e sem tenant no contexto o RLS devolveria só o
 * catálogo global, escondendo as raças do estabelecimento.
 *
 * TODO(MOD-PET-03): `POST /v1/breeds` (raça do tenant), `breed_visibility` e a
 * desativação de item em uso.
 */
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
}
