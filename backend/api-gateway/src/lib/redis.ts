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
} as const

export const CACHE_TTL_SECONDS = {
  jwks: 3600,
  permissions: 300,
  tenantByOrg: 3600,
  tenantStatus: 60,
  userByClerkId: 300,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})
