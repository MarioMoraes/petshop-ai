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

/**
 * Resolução host → tenant, para o site público (MOD-SITE-11 AC-01).
 *
 * É a consulta que **precede** o contexto de tenant por definição: o visitante é
 * anônimo e a única pista de qual petshop ele quer é o subdomínio. Devolve o mínimo
 * para decidir se a página existe — id, slug, nome e `status` — e nada mais; o resto
 * da montagem roda em `withTenant()` como qualquer outra leitura.
 *
 * O `status` sai daqui porque RN-06 manda o site acompanhar o estado da conta: tenant
 * fora de `ACTIVE` responde 404, publicado ou não. Uma página no ar de um cliente que
 * parou de pagar é a pior propaganda possível do produto.
 */
export async function resolveTenantBySlug(slug: string): Promise<TenantIdentity | null> {
  return runInPlatformScope(async () => {
    return getMaintenancePrisma().tenant.findFirst({
      where: { slug, deletedAt: null },
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

export interface InvitationRef {
  id: string
  tenantId: string
  tenantName: string
  tenantSlug: string
  tenantStatus: string
  tenantPlan: string
  clerkOrgId: string | null
  roleKey: string
  status: string
  expiresAt: Date
  /**
   * Índice cego (HMAC com pepper), não o endereço. É o que permite ao serviço
   * comparar o convite com quem está logado sem que esta camada — que roda fora do
   * RLS — chegue perto do e-mail em claro.
   */
  emailHash: string
}

/**
 * MOD-IDENT-06 — resolução do convite pelo token, antes de existir contexto de tenant.
 *
 * Quem clica no link ainda não é membro de nada: não há `app.tenant_id` para setar, e
 * sob RLS a busca voltaria vazia. É o mesmo caso de `resolveTenantByClerkOrgId` — uma
 * consulta que **precede** o tenant e por isso mora aqui, com o retorno fechado no
 * mínimo e sem nenhum dado pessoal em claro.
 *
 * A busca é por `token_hash`: o token cru nunca foi persistido, e quem não tem o link
 * não tem como enumerar convite nenhum.
 */
export async function resolveInvitationByTokenHash(
  tokenHash: string,
): Promise<InvitationRef | null> {
  return runInPlatformScope(async () => {
    const row = await getMaintenancePrisma().invitation.findFirst({
      where: { tokenHash, tenant: { deletedAt: null } },
      select: {
        id: true,
        tenantId: true,
        roleKey: true,
        status: true,
        expiresAt: true,
        emailHash: true,
        tenant: {
          select: { name: true, slug: true, status: true, plan: true, clerkOrgId: true },
        },
      },
    })
    if (!row) return null
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      tenantSlug: row.tenant.slug,
      tenantStatus: row.tenant.status,
      tenantPlan: row.tenant.plan,
      clerkOrgId: row.tenant.clerkOrgId,
      roleKey: row.roleKey,
      status: row.status,
      expiresAt: row.expiresAt,
      emailHash: row.emailHash,
    }
  })
}

/**
 * Varredura do job que expira convites (MOD-IDENT-06). Percorrer convites vencidos de
 * todos os tenants é cross-tenant por natureza — o caso que o PRD §4 destina à role
 * `app_maintenance`.
 */
export async function expirePendingInvitations(now = new Date()): Promise<number> {
  return runInPlatformScope(async () => {
    const result = await getMaintenancePrisma().invitation.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    })
    return result.count
  })
}

/**
 * O tenant de uma instância de WhatsApp, pelo hash do token do webhook (MOD-CRM-01).
 *
 * O callback da Evolution chega **sem contexto**: é um POST anônimo dizendo "a sessão
 * `tenant-fulano` abriu". Descobrir de quem é precede o contexto de tenant, exatamente
 * como resolver o convite pelo token — daí morar aqui, e não no serviço.
 *
 * Busca por hash: o token cru nunca é persistido, e quem não o tem não consegue
 * enumerar instância nenhuma. Devolve o mínimo — id do tenant e nome da instância —,
 * nenhum dado pessoal e nenhuma credencial: quem age é `withTenant()`, do outro lado.
 */
export async function resolveWhatsappInstanceByTokenHash(
  tokenHash: string,
): Promise<{ tenantId: string; instanceName: string } | null> {
  return runInPlatformScope(async () => {
    const row = await getMaintenancePrisma().whatsappInstance.findFirst({
      where: { webhookTokenHash: tokenHash, tenant: { deletedAt: null } },
      select: { tenantId: true, instanceName: true },
    })
    return row ? { tenantId: row.tenantId, instanceName: row.instanceName } : null
  })
}
