import { getPrisma, resolveEffectivePermissions, withTenant } from '@petshop/db'
import {
  IDENTITY_ROUTING_KEYS,
  ROLE_LABELS,
  ROLE_KEYS,
  isAssignableRole,
  isProfessionalRole,
  type AssignableRoleKey,
  type PermissionKey,
  type RoleKey,
  type RoleResponse,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { conflict, forbidden, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { getClerk } from '../../lib/clerk.js'
import { logger } from '../../lib/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from '../../lib/redis.js'

/**
 * MOD-IDENT-04 — RBAC.
 *
 * A matriz vive no banco (`role_permissions`, semeada de `@petshop/shared-types`) e
 * pode ser ajustada por tenant em `tenant_role_overrides`. Resolver permissão é,
 * portanto, uma consulta — não uma constante — e por isso passa por cache.
 *
 * O `permVersion` é o que resolve o AC-03: toda troca de papel o incrementa e limpa
 * o cache, de modo que uma sessão com token ainda válido não continue operando com o
 * papel antigo.
 */

export interface EffectivePermissions {
  role: RoleKey
  permissions: PermissionKey[]
  permVersion: number
}

export async function getEffectivePermissions(
  tenantId: string,
  userId: string,
): Promise<EffectivePermissions | null> {
  const cacheKey = CACHE_KEYS.permissions(tenantId, userId)
  const cached = await cacheGet<EffectivePermissions>(cacheKey)
  if (cached) return cached

  const resolved = await resolveFromDatabase(tenantId, userId)
  if (!resolved) return null

  await cacheSet(cacheKey, resolved, CACHE_TTL_SECONDS.permissions)
  return resolved
}

/**
 * AC-03 — o gateway compara o `permVersion` do token com o valor corrente. Divergiu,
 * ou o token não trazia o claim, força a releitura do banco e aplica o papel novo.
 */
export async function getFreshPermissions(
  tenantId: string,
  userId: string,
): Promise<EffectivePermissions | null> {
  const resolved = await resolveFromDatabase(tenantId, userId)
  if (!resolved) {
    await cacheDelete(CACHE_KEYS.permissions(tenantId, userId))
    return null
  }
  await cacheSet(CACHE_KEYS.permissions(tenantId, userId), resolved, CACHE_TTL_SECONDS.permissions)
  return resolved
}

async function resolveFromDatabase(
  tenantId: string,
  userId: string,
): Promise<EffectivePermissions | null> {
  // A matriz é resolvida em `@petshop/db`, compartilhada com o gateway: MOD-IDENT-04
  // exige a mesma verificação nos dois, e duas implementações divergiriam.
  const resolved = await resolveEffectivePermissions(tenantId, userId)
  if (!resolved) return null
  return {
    role: resolved.roleKey as RoleKey,
    permissions: resolved.permissions as PermissionKey[],
    permVersion: resolved.permVersion,
  }
}

export async function invalidatePermissions(tenantId: string, userId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.permissions(tenantId, userId))
}

// ─── Papéis ──────────────────────────────────────────────────────────────────

export async function listRoles(tenantId: string): Promise<RoleResponse[]> {
  return withTenant(tenantId, async (tx) => {
    const [roles, overrides] = await Promise.all([
      tx.role.findMany({
        include: { permissions: { select: { permissionKey: true } } },
        orderBy: { key: 'asc' },
      }),
      tx.tenantRoleOverride.findMany({ where: { tenantId } }),
    ])

    return roles.map((role) => {
      const effective = new Set(role.permissions.map((row) => row.permissionKey))
      for (const override of overrides.filter((item) => item.roleKey === role.key)) {
        if (override.granted) effective.add(override.permissionKey)
        else effective.delete(override.permissionKey)
      }
      return {
        key: role.key as RoleKey,
        label: role.label,
        isSystem: role.isSystem,
        assignable: isAssignableRole(role.key),
        permissions: [...effective].sort(),
      }
    })
  })
}

/** Ordem estável dos papéis, para a UI listar sempre igual. */
export const ROLE_DISPLAY_ORDER: RoleKey[] = [...ROLE_KEYS]

// ─── Troca de papel (mecanismo do AC-03) ─────────────────────────────────────

export interface ChangeRoleParams {
  tenantId: string
  membershipId: string
  newRole: AssignableRoleKey
  actorUserId: string
  ipAddress?: string | null
  userAgent?: string | null
}

export async function changeMembershipRole(params: ChangeRoleParams) {
  const { tenantId, membershipId, newRole, actorUserId } = params

  if (!isAssignableRole(newRole)) {
    // RN-05: TUTOR não é membership de operação; SUPER_ADMIN é papel de plataforma.
    throw forbidden('Este papel não pode ser atribuído a um membro da equipe')
  }

  const result = await withTenant(
    tenantId,
    async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { id: membershipId, tenantId },
        select: { id: true, userId: true, roleKey: true, permVersion: true, status: true },
      })
      // RLS já garante o escopo; o null aqui vira 404, nunca 403 — não revelamos
      // que o membership existe em outro tenant.
      if (!membership) throw notFound('Membro não encontrado')

      const previousRole = membership.roleKey as RoleKey
      if (previousRole === newRole) {
        return { membership, previousRole, changed: false as const }
      }

      // RN-02: o estabelecimento precisa de ao menos um administrador.
      if (previousRole === 'TENANT_ADMIN') {
        const remainingAdmins = await tx.membership.count({
          where: {
            tenantId,
            roleKey: 'TENANT_ADMIN',
            status: 'ACTIVE',
            id: { not: membershipId },
          },
        })
        if (remainingAdmins === 0) {
          throw conflict('O estabelecimento precisa de ao menos um administrador')
        }
      }

      const updated = await tx.membership.update({
        where: { id: membershipId },
        data: {
          roleKey: newRole,
          isProfessional: isProfessionalRole(newRole),
          permVersion: { increment: 1 },
        },
      })

      await recordAudit(tx, {
        tenantId,
        actorUserId,
        action: 'membership.role_changed',
        entity: 'membership',
        entityId: membershipId,
        before: { roleKey: previousRole },
        after: { roleKey: newRole },
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      })

      return { membership: updated, previousRole, changed: true as const }
    },
    { userId: actorUserId },
  )

  if (!result.changed) {
    return { id: result.membership.id, roleKey: newRole, permVersion: result.membership.permVersion }
  }

  // Invalidar antes de publicar: a próxima requisição do usuário não pode encontrar
  // o cache velho ainda quente.
  await invalidatePermissions(tenantId, result.membership.userId)
  await syncPermVersionToClerk(tenantId, result.membership.userId, result.membership.permVersion)

  await publishEvent(IDENTITY_ROUTING_KEYS.membershipPapelAlterado, {
    tenantId,
    userId: result.membership.userId,
    fromRole: result.previousRole,
    toRole: newRole,
    actorUserId,
  })

  return {
    id: result.membership.id,
    roleKey: newRole,
    permVersion: result.membership.permVersion,
  }
}

/**
 * Publica o `permVersion` no metadata do membership do Clerk, de onde o JWT template
 * o expõe como claim. Best-effort: se falhar, o gateway ainda detecta a divergência
 * pelo cache invalidado — só perde o atalho.
 */
async function syncPermVersionToClerk(
  tenantId: string,
  userId: string,
  permVersion: number,
): Promise<void> {
  try {
    const [tenant, user] = await Promise.all([
      withTenant(tenantId, (tx) =>
        tx.tenant.findUnique({ where: { id: tenantId }, select: { clerkOrgId: true } }),
      ),
      getPrisma().user.findUnique({ where: { id: userId }, select: { clerkUserId: true } }),
    ])
    if (!tenant?.clerkOrgId || !user?.clerkUserId) return

    await getClerk().setMembershipPermVersion({
      organizationId: tenant.clerkOrgId,
      clerkUserId: user.clerkUserId,
      permVersion,
    })
  } catch (error) {
    logger.warn({ err: error, tenantId, userId }, 'falha ao sincronizar permVersion no Clerk')
  }
}

// ─── Equipe ──────────────────────────────────────────────────────────────────

export interface MembershipSummary {
  id: string
  userId: string
  fullName: string
  avatarUrl: string | null
  mfaEnabled: boolean
  roleKey: RoleKey
  roleLabel: string
  status: string
  isProfessional: boolean
  joinedAt: string
}

export async function listMemberships(tenantId: string): Promise<MembershipSummary[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.membership.findMany({
      where: { status: { not: 'REMOVED' } },
      select: {
        id: true,
        userId: true,
        roleKey: true,
        status: true,
        isProfessional: true,
        joinedAt: true,
      },
      orderBy: { joinedAt: 'asc' },
    }),
  )

  // `users` é global e não tem RLS — a busca dos perfis é feita à parte, restrita aos
  // ids que o próprio tenant já enxerga.
  const users = await getPrisma().user.findMany({
    where: { id: { in: rows.map((row) => row.userId) } },
    select: { id: true, fullName: true, avatarUrl: true, mfaEnabled: true },
  })
  const byId = new Map(users.map((user) => [user.id, user]))

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    fullName: byId.get(row.userId)?.fullName ?? 'Usuário removido',
    avatarUrl: byId.get(row.userId)?.avatarUrl ?? null,
    mfaEnabled: byId.get(row.userId)?.mfaEnabled ?? false,
    roleKey: row.roleKey as RoleKey,
    roleLabel: ROLE_LABELS[row.roleKey as RoleKey] ?? row.roleKey,
    status: row.status,
    isProfessional: row.isProfessional,
    joinedAt: row.joinedAt.toISOString(),
  }))
}
