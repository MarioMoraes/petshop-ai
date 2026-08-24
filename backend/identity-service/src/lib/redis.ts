import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD §10. Falha de cache nunca derruba requisição: toda leitura degrada
 * para o banco e toda escrita é best-effort.
 */

export const CACHE_KEYS = {
  tenantSettings: (tenantId: string) => `tenant:settings:${tenantId}`,
  permissions: (tenantId: string, userId: string) => `perm:${tenantId}:${userId}`,
  tenantSlug: (slug: string) => `tenant:slug:${slug}`,
  tenantStatus: (tenantId: string) => `tenant:status:${tenantId}`,
} as const

export const CACHE_TTL_SECONDS = {
  tenantSettings: 600,
  permissions: 300,
  tenantSlug: 3600,
  tenantStatus: 60,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})
