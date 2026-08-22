import {
  getPrisma,
  listUserMemberships,
  resolveEffectivePermissions,
  resolveTenantByClerkOrgId,
} from '@petshop/db'
import { AppError, type PermissionKey, type RoleKey } from '@petshop/shared-types'
import type { ServiceAuthContext } from '@petshop/service-auth'
import { logger, recordMetric } from '../lib/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../lib/redis.js'
import type { SessionClaims } from './clerk-token.js'

/**
 * Resolução da sessão: do JWT do Clerk para o contexto que os serviços recebem.
 *
 * Três passos, todos com cache: Organization → tenant, usuário do Clerk → usuário
 * local, e a matriz de permissões efetiva. É o caminho quente do produto — o SLO do
 * PRD §10 pede 15ms no p95 com cache quente.
 */

interface CachedTenant {
  id: string
  slug: string
  status: string
  plan: string
}

interface CachedPermissions {
  roleKey: string
  permissions: string[]
  permVersion: number
}

/**
 * RN-04 — tenant suspenso bloqueia operação, mas leitura dos próprios dados e
 * exportação LGPD continuam liberadas.
 */
const BLOCKED_STATUSES = new Set(['SUSPENDED', 'TERMINATED'])
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface ResolveSessionResult {
  context: ServiceAuthContext
  tenantStatus: string | null
}

export async function resolveSession(
  claims: SessionClaims,
  method: string,
): Promise<ResolveSessionResult> {
  const userId = await resolveLocalUserId(claims.clerkUserId)

  const context: ServiceAuthContext = {
    clerkUserId: claims.clerkUserId,
    permissions: [],
  }
  if (userId) context.userId = userId

  if (!claims.clerkOrgId) {
    // Usuário autenticado sem Organization ativa: é o estado normal de quem ainda
    // vai criar o primeiro tenant (`POST /v1/tenants`).
    if (userId) await warnIfOrgClaimMissing(claims.clerkUserId, userId)
    return { context, tenantStatus: null }
  }

  const tenant = await resolveTenant(claims.clerkOrgId)
  if (!tenant) {
    // Organization existe no Clerk mas não tem tenant local: provisionamento
    // incompleto. Segue sem tenant, e o serviço decide.
    logger.warn({ clerkOrgId: claims.clerkOrgId }, 'Organization sem tenant local')
    return { context, tenantStatus: null }
  }

  if (BLOCKED_STATUSES.has(tenant.status) && !READ_METHODS.has(method)) {
    throw new AppError(
      'ERR_IDENT_008',
      tenant.status === 'SUSPENDED'
        ? 'Estabelecimento suspenso. Regularize a assinatura para voltar a operar.'
        : 'Estabelecimento encerrado.',
    )
  }

  context.tenantId = tenant.id

  if (userId) {
    const effective = await resolvePermissions(tenant.id, userId, claims.permVersion)
    if (effective) {
      context.role = effective.roleKey as RoleKey
      context.permissions = effective.permissions as PermissionKey[]
      context.permVersion = effective.permVersion
    }
  }

  return { context, tenantStatus: tenant.status }
}

/**
 * Aviso para o modo de falha silencioso do JWT template.
 *
 * Um template customizado do Clerk **não** herda os claims do token de sessão
 * padrão: o payload é só o que está declarado nele. Um template sem `org_id` produz
 * token válido, requisição 200 e sessão sem tenant — e o frontend fica preso no
 * onboarding sem que nada apareça como erro em lugar nenhum.
 *
 * Quem já tem vínculo ativo não deveria chegar aqui, então esse cruzamento nomeia a
 * causa. A consulta só acontece no caminho de quem não tem tenant resolvido, que é
 * o do onboarding — fora do caminho quente que o SLO do PRD §10 mede.
 */
async function warnIfOrgClaimMissing(clerkUserId: string, userId: string): Promise<void> {
  const active = (await listUserMemberships(userId)).filter(
    (membership) => membership.status === 'ACTIVE',
  )
  if (active.length === 0) return

  logger.warn(
    { clerkUserId, activeMemberships: active.length },
    'token sem `org_id` para usuário com vínculo ativo — confira os claims do JWT template `petshop` (docs/setup-clerk.md §3)',
  )
}

async function resolveTenant(clerkOrgId: string): Promise<CachedTenant | null> {
  const cacheKey = CACHE_KEYS.tenantByOrg(clerkOrgId)
  const cached = await cacheGet<CachedTenant>(cacheKey)
  // O status tem TTL próprio, bem mais curto: um tenant suspenso precisa ser
  // bloqueado em segundos, não na hora em que a identidade dele expirar.
  if (cached) {
    const status = await cacheGet<string>(CACHE_KEYS.tenantStatus(cached.id))
    if (status) return { ...cached, status }
  }

  const tenant = await resolveTenantByClerkOrgId(clerkOrgId)
  if (!tenant) return null

  const value: CachedTenant = {
    id: tenant.id,
    slug: tenant.slug,
    status: tenant.status,
    plan: tenant.plan,
  }
  await Promise.all([
    cacheSet(cacheKey, value, CACHE_TTL_SECONDS.tenantByOrg),
    cacheSet(CACHE_KEYS.tenantStatus(tenant.id), tenant.status, CACHE_TTL_SECONDS.tenantStatus),
  ])
  return value
}

async function resolveLocalUserId(clerkUserId: string): Promise<string | undefined> {
  const cacheKey = CACHE_KEYS.userByClerkId(clerkUserId)
  const cached = await cacheGet<string>(cacheKey)
  if (cached) return cached

  // `users` é tabela global, sem RLS — daí a consulta direta, fora de withTenant.
  const user = await getPrisma().user.findUnique({
    where: { clerkUserId },
    select: { id: true },
  })
  if (!user) {
    // Primeiro acesso: o espelho local ainda não existe. O identity-service o cria
    // sob demanda a partir do `clerkUserId` que segue nos headers.
    return undefined
  }

  await cacheSet(cacheKey, user.id, CACHE_TTL_SECONDS.userByClerkId)
  return user.id
}

/**
 * AC-03 de MOD-IDENT-04 — papel alterado com sessão ativa.
 *
 * Duas garantias, em ordem de custo:
 *
 *   1. O cache `perm:{tenantId}:{userId}` é invalidado na troca de papel. Sozinho
 *      isso já basta: a requisição seguinte do usuário rebaixado erra o cache e lê
 *      o papel novo do banco.
 *   2. O `permVersion` do token é conferido contra o do cache. Cobre o caso em que
 *      a invalidação não chegou — Redis reiniciado, réplica particionada — porque a
 *      divergência força a releitura mesmo com cache quente.
 *
 * Token sem o claim (JWT template não configurado, ver `docs/setup-clerk.md`) cai na
 * garantia 1. Ir ao banco a cada requisição nesse caso seria mais seguro no papel,
 * mas jogaria fora o cache inteiro e o p95 de 15ms junto — sem ganho real, já que a
 * invalidação na troca de papel continua valendo.
 */
async function resolvePermissions(
  tenantId: string,
  userId: string,
  tokenPermVersion: number | null,
): Promise<CachedPermissions | null> {
  const cacheKey = CACHE_KEYS.permissions(tenantId, userId)
  const cached = await cacheGet<CachedPermissions>(cacheKey)

  if (cached) {
    const diverged = tokenPermVersion !== null && tokenPermVersion !== cached.permVersion
    if (!diverged) return cached

    logger.info(
      { tenantId, userId, tokenPermVersion, currentPermVersion: cached.permVersion },
      'permVersion divergente entre token e cache — recarregando permissões',
    )
    recordMetric({ metric: 'perm_version_mismatch_total', tenantId, value: 1, unit: 'count' })
  }

  const resolved = await resolveEffectivePermissions(tenantId, userId)
  if (!resolved) return null

  await cacheSet(cacheKey, resolved, CACHE_TTL_SECONDS.permissions)
  return resolved
}
