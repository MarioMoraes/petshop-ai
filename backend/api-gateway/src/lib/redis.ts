import { Redis } from 'ioredis'
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

let client: Redis | null = null

export function getRedis(): Redis | null {
  if (loadEnv().DISABLE_REDIS) return null
  client ??= new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: 2 }).on('error', (error) => {
    logger.warn({ err: error }, 'erro no Redis — seguindo sem cache')
  })
  return client
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis()?.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch (error) {
    logger.warn({ err: error, key }, 'falha ao ler do cache')
    return null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis()?.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch (error) {
    logger.warn({ err: error, key }, 'falha ao gravar no cache')
  }
}

export async function cacheDelete(...keys: string[]): Promise<void> {
  if (keys.length === 0) return
  try {
    await getRedis()?.del(...keys)
  } catch (error) {
    logger.warn({ err: error, keys }, 'falha ao invalidar o cache')
  }
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined)
  client = null
}
