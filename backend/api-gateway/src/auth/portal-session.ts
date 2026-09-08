import { getPrisma, resolveTenantBySlug, withTenant } from '@petshop/db'
import {
  AppError,
  isPortalVisibleStatus,
  ROLE_PERMISSIONS,
  type PermissionKey,
} from '@petshop/shared-types'
import type { ServiceAuthContext } from '@petshop/service-auth'
import { logger } from '../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../shared/redis.js'
import type { SessionClaims } from './clerk-token.js'

/**
 * Resolução da sessão do **Portal do Tutor** (MOD-PORTAL-02).
 *
 * É um caminho paralelo ao de `session.ts`, e a diferença não é de implementação, é de
 * modelo: a sessão da equipe sai da Organization do Clerk e da tabela `memberships`; a
 * do tutor sai do **host** — o petshop de que se fala é o subdomínio — e de
 * `tutors.portal_user_id`.
 *
 * **Nada aqui consulta membership, em nenhuma circunstância.** É o AC-04 de
 * MOD-PORTAL-02, o caso do banhista que também leva o próprio cachorro no petshop onde
 * trabalha: entrando pelo Portal ele é tutor, com as nove permissões `_own` e nada
 * mais. Duas sessões, dois escopos; e o Portal nunca amplia por o usuário ter crachá.
 */

/** As nove permissões `_own` da matriz. Letra morta até este módulo existir. */
const TUTOR_PERMISSIONS = ROLE_PERMISSIONS.TUTOR as readonly PermissionKey[]

interface CachedPortalSession {
  tenantId: string
  tutorId: string
}

export interface PortalTenant {
  id: string
  slug: string
  name: string
}

/**
 * Host → tenant, a consulta que precede tudo no Portal.
 *
 * Passa por `packages/db/src/platform.ts`, a única porta para consulta anterior ao
 * contexto de tenant. Tenant desconhecido é 404, e não 401: quem digitou o subdomínio
 * errado não tem sessão a apresentar.
 */
export async function resolvePortalTenant(slug: string): Promise<PortalTenant> {
  const normalized = slug.trim().toLowerCase()
  if (normalized === '') throw new AppError('ERR_PORTAL_001', 'Estabelecimento não encontrado')

  const cached = await cacheGet<PortalTenant>(CACHE_KEYS.portalTenantBySlug(normalized))
  if (cached) return cached

  const tenant = await resolveTenantBySlug(normalized)
  if (!tenant || !isPortalVisibleStatus(tenant.status)) {
    throw new AppError('ERR_PORTAL_001', 'Estabelecimento não encontrado')
  }

  const value: PortalTenant = { id: tenant.id, slug: tenant.slug, name: tenant.name }
  await cacheSet(CACHE_KEYS.portalTenantBySlug(normalized), value, CACHE_TTL_SECONDS.portalTenantBySlug)
  return value
}

export interface PortalSessionResult {
  context: ServiceAuthContext
  tenant: PortalTenant
}

/**
 * Do JWT do Clerk para o contexto que o `portal-bff` recebe.
 *
 * `linked` falso não é erro: é o estado normal de quem acabou de criar a conta e ainda
 * vai vincular a ficha em `POST /portal/v1/access/verify`. O contexto sai sem `tutorId`
 * e sem permissão nenhuma — e é justamente por isso que só as rotas de acesso o
 * aceitam; qualquer outra cai no 401 de `requireTutorContext`.
 */
export async function resolvePortalSession(
  claims: SessionClaims,
  slug: string,
): Promise<PortalSessionResult> {
  const tenant = await resolvePortalTenant(slug)

  const context: ServiceAuthContext = {
    clerkUserId: claims.clerkUserId,
    tenantId: tenant.id,
    permissions: [],
  }

  const userId = await resolveLocalUserId(claims.clerkUserId)
  if (!userId) return { context, tenant }
  context.userId = userId

  const tutorId = await resolveLinkedTutor(tenant.id, userId)
  if (!tutorId) return { context, tenant }

  context.role = 'TUTOR'
  context.tutorId = tutorId
  context.permissions = [...TUTOR_PERMISSIONS]
  return { context, tenant }
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
  if (!user) return undefined

  await cacheSet(cacheKey, user.id, CACHE_TTL_SECONDS.userByClerkId)
  return user.id
}

/**
 * A ficha deste login neste petshop.
 *
 * `anonymizedAt` na condição, e não conferido depois: ficha anonimizada não é ficha
 * (AC-07 de MOD-PORTAL-01), e deixar a checagem para fora daria a quem exerceu o
 * direito de exclusão um acesso que continua funcionando.
 */
async function resolveLinkedTutor(tenantId: string, userId: string): Promise<string | null> {
  const cacheKey = CACHE_KEYS.portalSession(tenantId, userId)
  const cached = await cacheGet<CachedPortalSession>(cacheKey)
  if (cached) return cached.tutorId

  const tutor = await withTenant(tenantId, (tx) =>
    tx.tutor.findFirst({
      where: {
        portalUserId: userId,
        anonymizedAt: null,
        deletedAt: null,
        status: { not: 'MERGED' },
      },
      select: { id: true },
    }),
  )
  if (!tutor) return null

  await cacheSet(
    cacheKey,
    { tenantId, tutorId: tutor.id } satisfies CachedPortalSession,
    CACHE_TTL_SECONDS.portalSession,
  )
  return tutor.id
}

/**
 * Aviso do modo de falha silencioso do Portal.
 *
 * Uma conta do Clerk sem espelho local acontece no primeiro acesso e se resolve
 * sozinha; uma que persiste assim é sinal de que o identity-service não está criando o
 * espelho, e o sintoma para o tutor é uma tela de vínculo que nunca completa.
 */
export function warnUnlinkedSession(clerkUserId: string, slug: string): void {
  logger.debug({ clerkUserId, slug }, 'sessão do Portal sem ficha vinculada')
}
