import { ASSIGNABLE_ROLE_KEYS } from '@petshop/shared-types'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from '../auth.js'
import { parseInput } from '../validate.js'
import { ensureLocalUser } from '../users/service.js'
import { changeMembershipRole, listMemberships, listRoles } from './service.js'

/** MOD-IDENT-04 — papéis, matriz e troca de papel. */

const MembershipParamsSchema = z.object({ id: z.uuid() })
const ChangeRoleSchema = z.object({ role: z.enum(ASSIGNABLE_ROLE_KEYS) })

export async function registerRbacRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/roles',
    { preHandler: requirePermission('team:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listRoles(auth.tenantId)
    },
  )

  app.get(
    '/v1/memberships',
    { preHandler: requirePermission('team:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listMemberships(auth.tenantId)
    },
  )

  /**
   * A troca de papel é o mecanismo do AC-03: incrementa `permVersion`, invalida o
   * cache e republica o valor no Clerk.
   *
   * TODO(MOD-IDENT-05): suspensão, remoção e a checagem de agenda futura da RN-07
   * ficam para o módulo de membership.
   */
  app.patch(
    '/v1/memberships/:id',
    { preHandler: requirePermission('team:invite', 'Seu perfil não permite alterar papéis da equipe') },
    async (request) => {
      const auth = requireTenantContext(request)
      const { id } = parseInput(MembershipParamsSchema, request.params)
      const { role } = parseInput(ChangeRoleSchema, request.body)
      const actor = auth.userId ?? (await ensureLocalUser(auth.clerkUserId)).id

      return changeMembershipRole({
        tenantId: auth.tenantId,
        membershipId: id,
        newRole: role,
        actorUserId: actor,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      })
    },
  )
}
