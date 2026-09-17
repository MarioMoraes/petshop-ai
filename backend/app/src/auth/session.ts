import {
  getPrisma,
  listUserMemberships,
  resolveEffectivePermissions,
  resolveTenantByClerkOrgId,
  withTenant,
} from '@petshop/db'
import { AppError, type MfaState, type PermissionKey, type RoleKey } from '@petshop/shared-types'
import type { ServiceAuthContext } from '@petshop/service-auth'
import { logger, recordMetric } from '../shared/logger.js'
import { recordSecurityEvent } from '../shared/security-events.js'
import { mfaRequired } from '../modules/security/errors.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../shared/redis.js'
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
const BLOCKED_STATUSES = new Set(['SUSPENDED', 'TERMINATED', 'TRIAL_EXPIRED'])
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * A escrita que o bloqueio **não** pode barrar: assinar.
 *
 * Um estabelecimento em só leitura por teste vencido ou por falta de pagamento só sai
 * desse estado pagando — e pagar começa por um `POST`. Sem esta exceção a tela de
 * assinatura receberia o mesmo 423 que ela existe para resolver.
 */
const BILLING_PREFIX = '/v1/subscription'

function isBillingPath(path: string | undefined): boolean {
  return path === BILLING_PREFIX || (path?.startsWith(`${BILLING_PREFIX}/`) ?? false)
}

const BLOCKED_DETAIL: Record<string, string> = {
  SUSPENDED: 'Estabelecimento suspenso. Regularize a assinatura para voltar a operar.',
  TRIAL_EXPIRED:
    'O período de teste terminou. Assine um plano para voltar a registrar — os dados continuam aqui.',
  TERMINATED: 'Estabelecimento encerrado.',
}

/**
 * RN-01 de MOD-SEC — o único papel a que a exigência de MFA se aplica.
 *
 * É política da plataforma, e não configuração de tenant: uma proteção que o cliente
 * pode desligar fica desligada. E é só o administrador porque é o único papel que
 * anonimiza cliente, movimenta a conta corrente e convida gente — exigir de toda a
 * recepção multiplicaria o suporte sem mudar o que alguém faz com uma conta tomada.
 */
const MFA_REQUIRED_ROLES = new Set<RoleKey>(['TENANT_ADMIN'])

export interface ResolveSessionResult {
  context: ServiceAuthContext
  tenantStatus: string | null
  /**
   * O estado de MFA desta sessão (MOD-SEC-02 AC-04).
   *
   * **Fica fora do `ServiceAuthContext` de propósito.** Aquele é o contrato assinado
   * que atravessa para os serviços ainda não migrados, e o segundo fator é uma
   * condição da **porta**, verificada aqui, antes de qualquer roteamento. Um serviço
   * atrás dela não tem decisão a tomar com esse dado, e acrescentá-lo ao payload
   * canônico mudaria a assinatura HMAC sem que ninguém a lesse.
   */
  mfa: MfaState
}

/** De onde a requisição veio — prova de origem para o evento de segurança. */
export interface RequestOrigin {
  method: string
  /** O caminho sem query — decide a exceção de `BILLING_PREFIX`. */
  path?: string
  ipAddress?: string | null
  userAgent?: string | null
}

export async function resolveSession(
  claims: SessionClaims,
  origin: RequestOrigin,
): Promise<ResolveSessionResult> {
  const { method } = origin
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
    return { context, tenantStatus: null, mfa: notApplicable(claims) }
  }

  const tenant = await resolveTenant(claims.clerkOrgId)
  if (!tenant) {
    // Organization existe no Clerk mas não tem tenant local: provisionamento
    // incompleto. Segue sem tenant, e o serviço decide.
    logger.warn({ clerkOrgId: claims.clerkOrgId }, 'Organization sem tenant local')
    return { context, tenantStatus: null, mfa: notApplicable(claims) }
  }

  if (
    BLOCKED_STATUSES.has(tenant.status) &&
    !READ_METHODS.has(method) &&
    // Encerrado não assina de volta: é outra conversa, fora do produto.
    !(tenant.status !== 'TERMINATED' && isBillingPath(origin.path))
  ) {
    throw new AppError(
      'ERR_IDENT_008',
      BLOCKED_DETAIL[tenant.status] ?? 'Estabelecimento suspenso.',
      undefined,
      { tenantStatus: tenant.status },
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

  const mfa = await resolveMfaState(claims, tenant.id, userId, context.role)
  if (mfa.required && !mfa.enabled && !READ_METHODS.has(method) && graceExpired(mfa)) {
    /**
     * AC-06 de MOD-SEC-02 — a recusa vira evento de segurança, e **não** entra na
     * trilha de auditoria: `audit_logs` registra o que mudou, e aqui nada mudou. Um
     * administrador sem MFA clicando pela tela encheria a trilha de ruído e empurraria
     * o expurgo para cima. Padrão de tentativa mora em `security_events`.
     */
    await recordSecurityEvent({
      tenantId: tenant.id,
      type: 'MFA_REQUIRED',
      actorUserId: userId ?? null,
      ipAddress: origin.ipAddress ?? null,
      userAgent: origin.userAgent ?? null,
      metadata: { method },
    })
    recordMetric({ metric: 'mfa_write_blocked', tenantId: tenant.id, value: 1, unit: 'count' })

    // O catálogo é do módulo, e o host o importa — como já faz com o ramo de multipart
    // do MOD-PET em `shared/errors.ts`. Escrever o código à mão aqui abriria a porta
    // para ele divergir do que o §5 do PRD promete.
    throw mfaRequired()
  }

  return { context, tenantStatus: tenant.status, mfa }
}

/** Sem tenant não há papel, e sem papel a exigência não se aplica. */
function notApplicable(claims: SessionClaims): MfaState {
  return { required: false, enabled: claims.mfaEnabled === true, graceEndsAt: null }
}

function graceExpired(mfa: MfaState): boolean {
  return mfa.graceEndsAt === null || new Date(mfa.graceEndsAt).getTime() <= Date.now()
}

/**
 * O estado de segundo fator desta sessão (MOD-SEC-01 e MOD-SEC-03).
 *
 * **A decisão sai do claim, nunca de `users.mfa_enabled`.** Aquele campo é espelho,
 * gravado quando o `ensureLocalUser` sincroniza com o Clerk, e pode estar horas
 * atrasado. Decidir por espelho velho barraria justamente quem acabou de fazer o que o
 * produto pediu — o pior defeito que este gate pode ter.
 *
 * **A consulta ao membership só acontece no caminho de quem falta cumprir.** Papel que
 * não é administrador, ou administrador já com segundo fator, sai daqui sem tocar no
 * banco: o caminho quente do produto, que o SLO do PRD §10 mede em 15ms, não paga nada
 * por este módulo. É também o que dispensa mexer no cache `perm:` — mudar a forma dele
 * faria toda sessão quente de antes do deploy ler um campo que não existe.
 */
async function resolveMfaState(
  claims: SessionClaims,
  tenantId: string,
  userId: string | undefined,
  role: RoleKey | undefined,
): Promise<MfaState> {
  const enabled = claims.mfaEnabled === true
  if (!role || !MFA_REQUIRED_ROLES.has(role)) {
    return { required: false, enabled, graceEndsAt: null }
  }

  if (claims.mfaEnabled === null) {
    // AC-02 de MOD-SEC-01: "não sei" libera, e grita. Zero é o único valor aceitável
    // desta métrica — qualquer outro é o JWT template desatualizado.
    logger.warn(
      { clerkUserId: claims.clerkUserId, tenantId },
      'token sem o claim `mfa` para papel administrativo — confira o JWT template `petshop` (docs/setup-clerk.md §3)',
    )
    recordMetric({ metric: 'mfa_claim_missing', tenantId, value: 1, unit: 'count' })
    return { required: false, enabled: false, graceEndsAt: null }
  }

  if (enabled || !userId) return { required: true, enabled, graceEndsAt: null }

  /**
   * **Dentro de `withTenant`, e não em `getPrisma()` direto.** `memberships` tem RLS:
   * a consulta crua responde `TenantContextMissingError`, que o handler traduz em 404 —
   * e o sintoma seria o administrador sem segundo fator recebendo "não encontrado" em
   * toda rota, inclusive nas de leitura. Foi assim que este defeito apareceu, e o que o
   * denunciou foi o `TENANT_CONTEXT_MISSING` do MOD-SEC-07, ligado na mesma fatia.
   */
  const membership = await withTenant(tenantId, (tx) =>
    tx.membership.findFirst({
      where: { tenantId, userId, status: 'ACTIVE' },
      select: { mfaGraceUntil: true },
    }),
  )

  return {
    required: true,
    enabled: false,
    graceEndsAt: membership?.mfaGraceUntil?.toISOString() ?? null,
  }
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
    // Primeiro acesso: o espelho local ainda não existe. Quem o cria sob demanda é
    // o `ensureLocalUser` do MOD-IDENT, na primeira rota que precisar de um `userId`.
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
