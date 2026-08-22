import { UpdateTenantSettingsSchema } from '@petshop/shared-types'
import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from '../../auth/context.js'
import { parseInput } from '../../lib/validate.js'
import { ensureLocalUser } from '../users/service.js'
import { getSettings, updateSettings } from './service.js'

/** MOD-IDENT-08 (parcial) — o que a etapa 3 do wizard consome. */

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/tenants/me/settings',
    { preHandler: requirePermission('tenant:read_settings') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getSettings(auth.tenantId)
    },
  )

  app.patch(
    '/v1/tenants/me/settings',
    { preHandler: requirePermission('tenant:configure', 'Seu perfil não permite alterar as configurações') },
    async (request) => {
      const auth = requireTenantContext(request)
      const patch = parseInput(UpdateTenantSettingsSchema, request.body)
      const actor = auth.userId ?? (await ensureLocalUser(auth.clerkUserId)).id
      return updateSettings({ tenantId: auth.tenantId, actorUserId: actor, patch })
    },
  )
}
