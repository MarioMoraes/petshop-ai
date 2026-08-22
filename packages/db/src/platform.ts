import { getMaintenancePrisma } from './client.js'
import { runInPlatformScope } from './tenant-middleware.js'

/**
 * Consultas de plataforma — as que **precedem** o contexto de tenant e por isso não
 * podem passar pelo RLS.
 *
 * Resolver o tenant de uma sessão é, por definição, uma operação anterior a saber
 * qual é o tenant. Em vez de abrir a política ou espalhar o cliente de manutenção
 * pelo código, este módulo é a única porta: uma lista fechada de consultas, cada
 * uma devolvendo o mínimo necessário e nenhum dado pessoal.
 *
 * Regra: nada aqui devolve PII, e nada aqui escreve em dado de negócio.
 */

export interface TenantIdentity {
  id: string
  slug: string
  name: string
  status: string
  plan: string
  onboardingStep: number
  onboardingCompletedAt: Date | null
}

/**
 * Resolução slug → tenant, para o gate de disponibilidade da etapa 1 do wizard.
 * Considera o slug ocupado mesmo por tenant de outro dono — o slug é global.
 */
export async function isSlugTaken(slug: string): Promise<boolean> {
  return runInPlatformScope(async () => {
    const found = await getMaintenancePrisma().tenant.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    })
    return found !== null
  })
}

/** Quais destes slugs já existem. Uma consulta só, para filtrar sugestões. */
export async function filterTakenSlugs(slugs: string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set()
  return runInPlatformScope(async () => {
    const rows = await getMaintenancePrisma().tenant.findMany({
      where: { slug: { in: slugs }, deletedAt: null },
      select: { slug: true },
    })
    return new Set(rows.map((row) => row.slug))
  })
}

/** Bootstrap de sessão no gateway: Organization do Clerk → tenant local. */
export async function resolveTenantByClerkOrgId(
  clerkOrgId: string,
): Promise<TenantIdentity | null> {
  return runInPlatformScope(async () => {
    return getMaintenancePrisma().tenant.findFirst({
      where: { clerkOrgId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        plan: true,
        onboardingStep: true,
        onboardingCompletedAt: true,
      },
    })
  })
}

export async function resolveTenantById(tenantId: string): Promise<TenantIdentity | null> {
  return runInPlatformScope(async () => {
    return getMaintenancePrisma().tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        plan: true,
        onboardingStep: true,
        onboardingCompletedAt: true,
      },
    })
  })
}

export interface UserMembershipRef {
  tenantId: string
  tenantName: string
  tenantSlug: string
  roleKey: string
  status: string
  permVersion: number
}

/**
 * RN-01: um usuário pertence a N tenants. Listar os vínculos dele é
 * intrinsecamente cross-tenant — é o que alimenta `GET /v1/me` e, adiante,
 * o `switch-tenant` de MOD-IDENT-05.
 */
export async function listUserMemberships(userId: string): Promise<UserMembershipRef[]> {
  return runInPlatformScope(async () => {
    const rows = await getMaintenancePrisma().membership.findMany({
      where: { userId, status: { not: 'REMOVED' }, tenant: { deletedAt: null } },
      select: {
        tenantId: true,
        roleKey: true,
        status: true,
        permVersion: true,
        tenant: { select: { name: true, slug: true } },
      },
      orderBy: { joinedAt: 'asc' },
    })
    return rows.map((row) => ({
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      tenantSlug: row.tenant.slug,
      roleKey: row.roleKey,
      status: row.status,
      permVersion: row.permVersion,
    }))
  })
}

/** Vínculo do usuário num tenant específico, para o gateway resolver permissões. */
export async function findMembership(
  tenantId: string,
  userId: string,
): Promise<UserMembershipRef | null> {
  const memberships = await listUserMemberships(userId)
  return memberships.find((membership) => membership.tenantId === tenantId) ?? null
}

/**
 * Fila do job `tenant-provisioning-retry` (AC-03 de MOD-IDENT-01). Varrer tenants
 * presos em PROVISIONING é cross-tenant por natureza — exatamente o caso em que o
 * PRD manda usar `app_maintenance`.
 */
export async function listTenantsPendingProvisioning(maxAttempts: number) {
  return runInPlatformScope(async () => {
    return getMaintenancePrisma().tenant.findMany({
      where: {
        status: 'PROVISIONING',
        provisioningAttempts: { lt: maxAttempts },
        deletedAt: null,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        plan: true,
        provisioningKey: true,
        provisioningAttempts: true,
        clerkOrgId: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })
  })
}
