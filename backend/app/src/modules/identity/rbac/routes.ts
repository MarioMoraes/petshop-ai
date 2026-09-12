import { ASSIGNABLE_ROLE_KEYS } from '@petshop/shared-types'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from '../auth.js'
import { parseInput } from '../validate.js'
import { ensureLocalUser } from '../users/service.js'
import {
  changeMembershipRole,
  changeMembershipStatus,
  listMemberships,
  listRoles,
  removeMembership,
} from './service.js'

/** MOD-IDENT-04 — papéis, matriz e troca de papel. */

const MembershipParamsSchema = z.object({ id: z.uuid() })
const ChangeRoleSchema = z.object({ role: z.enum(ASSIGNABLE_ROLE_KEYS) })
/**
 * `REMOVED` **não** entra: remover é `DELETE`, e aceitar o mesmo efeito por duas portas
 * daria dois caminhos para a guarda da agenda futura — um deles fatalmente sem ela.
 */
const ChangeStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) })

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
   * Suspensão, remoção e a checagem de agenda futura da RN-07 são as duas rotas logo
   * abaixo — a troca de papel é a única das três que não mexe em `status`.
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

  /**
   * MOD-IDENT-05 — suspender e reativar.
   *
   * Sob `team:remove`, e não `team:invite`: a matriz separa "convidar" de "remover"
   * desde o MOD-IDENT-04, e fechar a porta de alguém é da segunda família. A permissão
   * existia no catálogo sem nenhuma rota que a exigisse.
   */
  app.patch(
    '/v1/memberships/:id/status',
    {
      preHandler: requirePermission(
        'team:remove',
        'Seu perfil não permite alterar o acesso da equipe',
      ),
    },
    async (request) => {
      const auth = requireTenantContext(request)
      const { id } = parseInput(MembershipParamsSchema, request.params)
      const { status } = parseInput(ChangeStatusSchema, request.body)
      const actor = auth.userId ?? (await ensureLocalUser(auth.clerkUserId)).id

      return changeMembershipStatus({
        tenantId: auth.tenantId,
        membershipId: id,
        status,
        actorUserId: actor,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      })
    },
  )

  /**
   * MOD-IDENT-05 — remover da equipe.
   *
   * `DELETE` na rota, `REMOVED` no banco: o vínculo é o antecedente do que a pessoa fez
   * no estabelecimento, e a trilha não pode apontar para uma linha apagada.
   */
  app.delete(
    '/v1/memberships/:id',
    {
      preHandler: requirePermission(
        'team:remove',
        'Seu perfil não permite remover membros da equipe',
      ),
    },
    async (request) => {
      const auth = requireTenantContext(request)
      const { id } = parseInput(MembershipParamsSchema, request.params)
      const actor = auth.userId ?? (await ensureLocalUser(auth.clerkUserId)).id

      return removeMembership({
        tenantId: auth.tenantId,
        membershipId: id,
        actorUserId: actor,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      })
    },
  )
}
