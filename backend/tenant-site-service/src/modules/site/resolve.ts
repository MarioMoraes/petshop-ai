import { resolveTenantBySlug, type TenantIdentity } from '@petshop/db'
import { isSiteVisibleStatus } from '@petshop/shared-types'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../../lib/redis.js'
import { notFound } from '../../lib/errors.js'

/**
 * Host → tenant, a consulta que precede tudo na superfície pública.
 *
 * O visitante é anônimo e a única pista de qual petshop ele quer é o subdomínio. A
 * resolução passa por `packages/db/src/platform.ts`, a única porta para consultas
 * anteriores ao contexto de tenant.
 *
 * **Tenant suspenso é tratado como inexistente** (RN-06): 404, publicado ou não. O site
 * é entrega comercial e acompanha o estado da conta — uma página no ar de um cliente
 * que parou de pagar é a pior propaganda possível do produto. Quais estados ainda
 * servem está em `SITE_VISIBLE_TENANT_STATUSES`, com a divergência do PRD explicada:
 * `TRIAL` não pode cair, senão o site nasce fora do ar para todo cliente novo.
 *
 * O cache negativo tem TTL curto de propósito: o tenant que acaba de nascer não pode
 * ficar uma hora invisível porque um bot pediu o subdomínio dele antes.
 */

export interface ResolvedTenant {
  id: string
  slug: string
  name: string
}

export async function resolveTenant(slug: string): Promise<ResolvedTenant> {
  const normalized = slug.trim().toLowerCase()
  if (normalized === '') throw notFound()

  const miss = await cacheGet<boolean>(CACHE_KEYS.hostMiss(normalized))
  if (miss) throw notFound()

  const cached = await cacheGet<ResolvedTenant>(CACHE_KEYS.host(normalized))
  if (cached) return cached

  const tenant: TenantIdentity | null = await resolveTenantBySlug(normalized)

  if (!tenant || !isSiteVisibleStatus(tenant.status)) {
    await cacheSet(CACHE_KEYS.hostMiss(normalized), true, CACHE_TTL_SECONDS.hostMiss)
    throw notFound()
  }

  const resolved: ResolvedTenant = { id: tenant.id, slug: tenant.slug, name: tenant.name }
  await cacheSet(CACHE_KEYS.host(normalized), resolved, CACHE_TTL_SECONDS.host)
  return resolved
}
