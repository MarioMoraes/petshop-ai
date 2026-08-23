import { Redis } from 'ioredis'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD pets_03 §10. Falha de cache nunca derruba requisição: toda leitura
 * degrada para o banco e toda escrita é best-effort.
 *
 * O catálogo é o item com maior retorno: muda quase nunca, é lido em toda abertura
 * de formulário de pet e tem SLO de 60ms. A listagem com busca deliberadamente não
 * é cacheada — alta cardinalidade e dado fresco com o cliente no balcão.
 */

export const CACHE_KEYS = {
  pet: (tenantId: string, petId: string) => `pet:${tenantId}:${petId}`,
  petsByTutor: (tenantId: string, tutorId: string) => `pet:bytutor:${tenantId}:${tutorId}`,
  catalog: (tenantId: string, type: string) => `catalog:${tenantId}:${type}`,
  photoUrls: (photoId: string) => `photo:url:${photoId}`,
} as const

export const CACHE_TTL_SECONDS = {
  pet: 120,
  petsByTutor: 300,
  catalog: 86_400,
  /** Abaixo dos 900s da assinatura: cache nunca deve servir URL prestes a vencer. */
  photoUrls: 840,
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

/**
 * Invalida tudo o que depende de um pet. Os tutores entram na lista porque o Portal
 * lista "meus pets" por tutor: mudar o pet sem invalidar essa chave deixaria o tutor
 * vendo o nome antigo por cinco minutos.
 */
export async function invalidatePet(
  tenantId: string,
  petId: string,
  tutorIds: string[] = [],
): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.pet(tenantId, petId),
    ...tutorIds.map((tutorId) => CACHE_KEYS.petsByTutor(tenantId, tutorId)),
  )
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined)
  client = null
}
