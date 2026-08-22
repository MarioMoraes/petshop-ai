import { Redis } from 'ioredis'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD tutores_02 §10. Falha de cache nunca derruba requisição: toda leitura
 * degrada para o banco e toda escrita é best-effort.
 *
 * A busca (`GET /v1/tutors?q=`) deliberadamente **não** é cacheada: alta cardinalidade
 * e necessidade de dado fresco com o cliente no balcão.
 */

export const CACHE_KEYS = {
  tutor: (tenantId: string, tutorId: string) => `tutor:${tenantId}:${tutorId}`,
  consents: (tenantId: string, tutorId: string) => `tutor:consent:${tenantId}:${tutorId}`,
  /** Resolução telefone → tutorId, usada pelo agente de IA no WhatsApp. */
  phone: (tenantId: string, phoneHash: string) => `tutor:phone:${tenantId}:${phoneHash}`,
  tagCounts: (tenantId: string) => `tutor:tagcount:${tenantId}`,
  cep: (zipCode: string) => `cep:${zipCode}`,
} as const

export const CACHE_TTL_SECONDS = {
  tutor: 120,
  consents: 300,
  phone: 600,
  tagCounts: 300,
  cep: 86_400,
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

/** Invalida tudo o que depende de um tutor. Chamado depois de qualquer escrita. */
export async function invalidateTutor(
  tenantId: string,
  tutorId: string,
  phoneHashes: string[] = [],
): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.tutor(tenantId, tutorId),
    CACHE_KEYS.consents(tenantId, tutorId),
    CACHE_KEYS.tagCounts(tenantId),
    ...phoneHashes.map((hash) => CACHE_KEYS.phone(tenantId, hash)),
  )
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined)
  client = null
}
