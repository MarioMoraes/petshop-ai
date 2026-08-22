import { listUserMemberships } from '@petshop/db'
import { ROLE_LABELS, type MeResponse, type RoleKey } from '@petshop/shared-types'
import type { FastifyInstance } from 'fastify'
import { getEffectivePermissions } from '../rbac/service.js'
import { getTenant } from '../tenants/service.js'
import { ensureLocalUser } from '../users/service.js'

/**
 * `GET /v1/me` — perfil, vínculos e permissões efetivas.
 *
 * É a primeira chamada de toda sessão do frontend e o que decide o roteamento
 * (onboarding vs. dashboard). Fica sob o SLO mais apertado do PRD §10: p95 de 120ms.
 *
 * A listagem de vínculos é cross-tenant por natureza (RN-01) e por isso vem de
 * `listUserMemberships`, do conjunto de consultas de plataforma.
 */
export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/me', async (request): Promise<MeResponse> => {
    const user = await ensureLocalUser(request.auth.clerkUserId)
    const memberships = await listUserMemberships(user.id)

    const tenantId = request.auth.tenantId
    const currentTenant = tenantId ? await getTenant(tenantId) : null
    const effective = tenantId ? await getEffectivePermissions(tenantId, user.id) : null

    return {
      user: {
        id: user.id,
        clerkUserId: user.clerkUserId,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        mfaEnabled: user.mfaEnabled,
      },
      currentTenant,
      memberships: memberships.map((membership) => ({
        tenantId: membership.tenantId,
        tenantName: membership.tenantName,
        tenantSlug: membership.tenantSlug,
        roleKey: membership.roleKey as RoleKey,
        roleLabel: ROLE_LABELS[membership.roleKey as RoleKey] ?? membership.roleKey,
        status: membership.status as 'ACTIVE' | 'SUSPENDED' | 'REMOVED',
      })),
      permissions: effective?.permissions ?? [],
      permVersion: effective?.permVersion ?? 0,
    }
  })
}
