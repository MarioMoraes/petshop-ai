import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD §10. Compartilhado entre réplicas do gateway — é o que permite que a
 * verificação de permissão fique no p95 de 15ms com cache quente.
 *
 * Toda operação degrada em silêncio: Redis fora do ar deixa o gateway mais lento,
 * nunca indisponível.
 */

export const CACHE_KEYS = {
  jwks: 'clerk:jwks',
  permissions: (tenantId: string, userId: string) => `perm:${tenantId}:${userId}`,
  tenantByOrg: (clerkOrgId: string) => `tenant:org:${clerkOrgId}`,
  tenantStatus: (tenantId: string) => `tenant:status:${tenantId}`,
  userByClerkId: (clerkUserId: string) => `user:clerk:${clerkUserId}`,
  /**
   * Namespace `portal:` de propósito. O identity-service já declara um
   * `tenant:slug:{slug}`, e duas chaves com o mesmo nome e formatos diferentes é o tipo
   * de colisão que só aparece quando as duas estão quentes ao mesmo tempo.
   */
  portalTenantBySlug: (slug: string) => `portal:tenant:${slug}`,
  /**
   * A sessão do Portal. **O nome é contrato entre serviços**, como o `perm:` que o
   * identity-service invalida: o tutor-service apaga esta chave ao desvincular o acesso,
   * e é o que faz o AC-05 de MOD-PORTAL-02 valer antes do TTL.
   */
  portalSession: (tenantId: string, userId: string) => `portal:session:${tenantId}:${userId}`,
} as const

export const CACHE_TTL_SECONDS = {
  jwks: 3600,
  permissions: 300,
  tenantByOrg: 3600,
  tenantStatus: 60,
  userByClerkId: 300,
  portalTenantBySlug: 3600,
  /**
   * Curto de propósito. É o mecanismo que substitui o `permVersion` na sessão do
   * Portal: o claim vem do metadata do membership no Clerk, e o tutor não tem
   * membership. Desvincular o acesso apaga esta chave; o minuto é o pior caso de quem
   * revoga com a chave já apagada por outra réplica (AC-05 de MOD-PORTAL-02).
   */
  portalSession: 60,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})
