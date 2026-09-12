import {
  getPrisma,
  resolveEffectivePermissions,
  withTenant,
  type TenantTransaction,
} from '@petshop/db'
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
import { recordAudit } from '../../../shared/audit.js'
import { getScheduling } from '../scheduling-port.js'
import { conflict, forbidden, notFound } from '../errors.js'
import { publishEvent } from '../../../shared/events.js'
import { getClerk } from '../clerk.js'
import { mfaGraceFor } from '../../security/mfa.js'
import { logger } from '../../../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from '../../../shared/redis.js'

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

/**
 * RN-02 — o estabelecimento precisa de ao menos um administrador.
 *
 * Vale para os três caminhos que podem tirar o último: rebaixar o papel, suspender o
 * acesso e remover o vínculo. **O `id: { not: … }` é o que faz a conta ser sobre o
 * depois, e não sobre o agora** — sem ele o próprio membership em questão contaria como
 * administrador remanescente e a guarda nunca dispararia.
 *
 * Roda dentro da transação de quem chama, e não antes dela: entre a contagem e a
 * escrita cabe a promoção de outra pessoa, e a checagem precisa valer no mesmo instante
 * da mudança.
 */
async function assertNotLastAdmin(
  tx: TenantTransaction,
  tenantId: string,
  membershipId: string,
): Promise<void> {
  const remainingAdmins = await tx.membership.count({
    where: { tenantId, roleKey: 'TENANT_ADMIN', status: 'ACTIVE', id: { not: membershipId } },
  })
  if (remainingAdmins === 0) {
    throw conflict('O estabelecimento precisa de ao menos um administrador')
  }
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
        await assertNotLastAdmin(tx, tenantId, membershipId)
      }

      const updated = await tx.membership.update({
        where: { id: membershipId },
        data: {
          roleKey: newRole,
          isProfessional: isProfessionalRole(newRole),
          permVersion: { increment: 1 },
          /**
           * MOD-SEC-03 — AC-02 e AC-04 na mesma linha.
           *
           * Promover concede carência nova; rebaixar devolve `null`, porque quem deixa
           * de ser administrador não tem prazo a cumprir. Promover de novo mais tarde
           * concede outro prazo, e é o comportamento certo: a exigência é do papel.
           */
          mfaGraceUntil: mfaGraceFor(newRole),
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

// ─── Suspensão, reativação e remoção (MOD-IDENT-05) ──────────────────────────

export interface MembershipActionParams {
  tenantId: string
  membershipId: string
  actorUserId: string
  ipAddress?: string | null
  userAgent?: string | null
}

export interface MembershipActionResult {
  id: string
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED'
}

/**
 * Suspender e reativar o acesso de alguém da equipe.
 *
 * **Suspender não consulta a agenda**, e é a diferença em relação a remover: quem entra
 * de licença continua dono dos compromissos dela, e é normal que a agenda de sábado siga
 * no nome de quem volta na quinta. O que a suspensão faz é fechar a porta — e quem a
 * fecha de fato é `resolveEffectivePermissions`, que só enxerga vínculo `ACTIVE`.
 *
 * O `permVersion` incrementa nos dois sentidos. Sem isso, quem está com token válido na
 * mão continuaria operando com a permissão de antes até ele expirar (RN-03).
 */
export async function changeMembershipStatus(
  params: MembershipActionParams & { status: 'ACTIVE' | 'SUSPENDED' },
): Promise<MembershipActionResult> {
  const { tenantId, membershipId, actorUserId, status } = params

  const result = await withTenant(
    tenantId,
    async (tx) => {
      const membership = await requireMembership(tx, tenantId, membershipId, actorUserId)
      if (membership.status === status) {
        return { membership, changed: false as const }
      }
      if (membership.status === 'REMOVED') {
        // Reativar quem foi removido seria devolver acesso sem passar por convite, e o
        // convite é onde o assento do plano é conferido (RN-11).
        throw conflict('Este vínculo foi removido. Envie um convite novo para readmitir.')
      }

      // RN-02, no caminho da suspensão: fechar a porta do único administrador tranca o
      // estabelecimento inteiro, e ninguém de dentro consegue destrancar.
      if (status === 'SUSPENDED' && membership.roleKey === 'TENANT_ADMIN') {
        await assertNotLastAdmin(tx, tenantId, membershipId)
      }

      const updated = await tx.membership.update({
        where: { id: membershipId },
        data: { status, permVersion: { increment: 1 } },
      })

      await recordAudit(tx, {
        tenantId,
        actorUserId,
        action: status === 'SUSPENDED' ? 'membership.suspended' : 'membership.reactivated',
        entity: 'membership',
        entityId: membershipId,
        before: { status: membership.status },
        after: { status },
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      })

      return { membership: updated, changed: true as const }
    },
    { userId: actorUserId },
  )

  if (!result.changed) {
    return { id: membershipId, status }
  }

  await invalidatePermissions(tenantId, result.membership.userId)
  await syncPermVersionToClerk(tenantId, result.membership.userId, result.membership.permVersion)

  await publishEvent(
    status === 'SUSPENDED'
      ? IDENTITY_ROUTING_KEYS.membershipSuspenso
      : IDENTITY_ROUTING_KEYS.membershipReativado,
    {
      tenantId,
      userId: result.membership.userId,
      roleKey: result.membership.roleKey as RoleKey,
      actorUserId,
      reason: null,
    },
  )

  return { id: membershipId, status }
}

/**
 * Tirar alguém da equipe.
 *
 * `REMOVED` e não `DELETE`: o vínculo é o antecedente de tudo o que a pessoa fez no
 * estabelecimento — atendimento assinado, receita emitida, lançamento feito —, e apagar
 * a linha deixaria a trilha apontando para um id que não existe mais.
 *
 * Duas guardas, e a ordem entre elas é deliberada: **o último administrador é recusado
 * antes de a agenda ser consultada**. As duas terminam em 409, e a primeira é a que a
 * pessoa na tela pode resolver sozinha promovendo alguém; fazer a consulta da agenda
 * primeiro daria uma lista de agendamentos para reatribuir num caminho que ia ser
 * recusado de qualquer jeito.
 */
export async function removeMembership(
  params: MembershipActionParams,
): Promise<MembershipActionResult> {
  const { tenantId, membershipId, actorUserId } = params

  const result = await withTenant(
    tenantId,
    async (tx) => {
      const membership = await requireMembership(tx, tenantId, membershipId, actorUserId)
      if (membership.status === 'REMOVED') {
        return { membership, changed: false as const }
      }

      if (membership.roleKey === 'TENANT_ADMIN') {
        await assertNotLastAdmin(tx, tenantId, membershipId)
      }

      /**
       * RN-07 — a agenda futura, pela porta.
       *
       * O corpo do 409 leva os agendamentos porque a decisão é de quem está na tela:
       * reatribuir a outro profissional ou cancelar. Decidir aqui, cancelando em lote,
       * seria o sistema desmarcando o banho de sábado de um cliente que não foi
       * avisado.
       */
      const futuros = await getScheduling().listFutureProfessionalAppointments(
        tx,
        tenantId,
        membership.userId,
      )
      if (futuros.length > 0) {
        throw conflict(
          `Esta pessoa tem ${futuros.length} ${futuros.length === 1 ? 'agendamento' : 'agendamentos'} futuro${futuros.length === 1 ? '' : 's'}. Reatribua ou cancele antes de remover.`,
          undefined,
          { appointments: futuros },
        )
      }

      const updated = await tx.membership.update({
        where: { id: membershipId },
        data: {
          status: 'REMOVED',
          permVersion: { increment: 1 },
          // Quem sai não tem prazo de MFA a cumprir. Readmitido, ganha prazo novo — a
          // exigência é do papel, e o papel é atribuído de novo no aceite.
          mfaGraceUntil: null,
        },
      })

      await recordAudit(tx, {
        tenantId,
        actorUserId,
        action: 'membership.removed',
        entity: 'membership',
        entityId: membershipId,
        before: { status: membership.status, roleKey: membership.roleKey },
        after: { status: 'REMOVED' },
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      })

      return { membership: updated, changed: true as const }
    },
    { userId: actorUserId },
  )

  if (!result.changed) {
    return { id: membershipId, status: 'REMOVED' }
  }

  await invalidatePermissions(tenantId, result.membership.userId)
  await removeFromClerkOrganization(tenantId, result.membership.userId)

  await publishEvent(IDENTITY_ROUTING_KEYS.membershipRemovido, {
    tenantId,
    userId: result.membership.userId,
    roleKey: result.membership.roleKey as RoleKey,
  })

  return { id: membershipId, status: 'REMOVED' }
}

/**
 * O vínculo que a ação vai mexer, com as duas recusas que valem para as três ações.
 *
 * O 404 de vínculo inexistente **não distingue** "não existe" de "é de outro
 * estabelecimento": o RLS já garante o escopo, e um 403 aqui contaria que o id existe
 * em algum lugar.
 */
async function requireMembership(
  tx: TenantTransaction,
  tenantId: string,
  membershipId: string,
  actorUserId: string,
) {
  const membership = await tx.membership.findFirst({
    where: { id: membershipId, tenantId },
    select: { id: true, userId: true, roleKey: true, status: true, permVersion: true },
  })
  if (!membership) throw notFound('Membro não encontrado')

  /**
   * Ninguém age sobre o próprio vínculo.
   *
   * Suspender-se ou remover-se é a via mais curta para um estabelecimento sem
   * administrador, e o 409 da RN-02 só cobre o caso em que a pessoa é a última — quem
   * tem um colega administrador conseguiria se trancar fora do sistema com um clique, e
   * o desfazer não estaria mais ao alcance dela.
   */
  if (membership.userId === actorUserId) {
    throw forbidden('Você não pode alterar o seu próprio acesso')
  }

  return membership
}

/**
 * Tira a pessoa da Organization do Clerk, best-effort como `syncPermVersionToClerk`.
 *
 * O vínculo `REMOVED` já basta para barrar — `resolveEffectivePermissions` devolve nulo
 * e a sessão não resolve permissão nenhuma. O que esta chamada evita é a incoerência
 * visível: sem ela a pessoa continua vendo o estabelecimento na lista do seletor do
 * Clerk, entra, e recebe uma tela vazia sem explicação.
 */
async function removeFromClerkOrganization(tenantId: string, userId: string): Promise<void> {
  try {
    const [tenant, user] = await Promise.all([
      withTenant(tenantId, (tx) =>
        tx.tenant.findUnique({ where: { id: tenantId }, select: { clerkOrgId: true } }),
      ),
      getPrisma().user.findUnique({ where: { id: userId }, select: { clerkUserId: true } }),
    ])
    if (!tenant?.clerkOrgId || !user?.clerkUserId) return

    await getClerk().removeOrganizationMembership({
      organizationId: tenant.clerkOrgId,
      clerkUserId: user.clerkUserId,
    })
  } catch (error) {
    logger.warn({ err: error, tenantId, userId }, 'falha ao remover membership no Clerk')
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
