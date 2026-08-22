import { Redis } from 'ioredis'
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

let client: Redis | null = null

export function getRedis(): Redis | null {
  if (loadEnv().DISABLE_REDIS) return null
  client ??= new Redis(loadEnv().REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  }).on('error', (error) => {
    logger.warn({ err: error }, 'Erro no Redis — seguindo sem cache')
  })
  return client
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis()?.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch (error) {
    logger.warn({ err: error, key }, 'Falha ao ler do cache')
    return null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis()?.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch (error) {
    logger.warn({ err: error, key }, 'Falha ao gravar no cache')
  }
}

export async function cacheDelete(...keys: string[]): Promise<void> {
  if (keys.length === 0) return
  try {
    await getRedis()?.del(...keys)
  } catch (error) {
    logger.warn({ err: error, keys }, 'Falha ao invalidar o cache')
  }
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined)
  client = null
}
