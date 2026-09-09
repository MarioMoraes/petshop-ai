import { CreateTenantSchema, UpdateTenantSchema } from '@petshop/shared-types'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from '../auth.js'
import { parseInput } from '../validate.js'
import { ensureLocalUser } from '../users/service.js'
import {
  checkSlugAvailability,
  getTenant,
  provisionTenant,
  updateTenant,
} from './service.js'

/** MOD-IDENT-01 — rotas de tenant. */

const SlugQuerySchema = z.object({ slug: z.string().min(1).max(60) })

export async function registerTenantRoutes(app: FastifyInstance): Promise<void> {
  /**
   * AC-01 — provisiona o tenant do usuário autenticado.
   *
   * É a única rota de negócio sem `tenant_id`: quem chama ainda não tem tenant nenhum.
   */
  app.post('/v1/tenants', async (request, reply) => {
    const input = parseInput(CreateTenantSchema, request.body)
    const tenant = await provisionTenant({
      input,
      clerkUserId: request.auth.clerkUserId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    })
    return reply.status(201).send(tenant)
  })

  /** Feedback ao vivo da etapa 1 do wizard. */
  app.get('/v1/tenants/slug-availability', async (request) => {
    const { slug } = parseInput(SlugQuerySchema, request.query)
    return checkSlugAvailability(slug)
  })

  /** Liberado a todos do tenant (PRD §5). */
  app.get('/v1/tenants/me', async (request) => {
    const auth = requireTenantContext(request)
    return getTenant(auth.tenantId)
  })

  app.patch(
    '/v1/tenants/me',
    { preHandler: requirePermission('tenant:configure', 'Seu perfil não permite alterar o estabelecimento') },
    async (request) => {
      const auth = requireTenantContext(request)
      const data = parseInput(UpdateTenantSchema, request.body)
      const actor = auth.userId ?? (await ensureLocalUser(auth.clerkUserId)).id
      return updateTenant({ tenantId: auth.tenantId, actorUserId: actor, data })
    },
  )
}
