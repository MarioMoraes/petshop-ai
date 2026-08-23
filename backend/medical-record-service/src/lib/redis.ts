import { Redis } from 'ioredis'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD prontuario_04 §10. Falha de cache nunca derruba requisição: toda
 * leitura degrada para o banco e toda escrita é best-effort.
 *
 * O alerta do pet é o item quente: é lido em toda abertura de ficha, em todo
 * agendamento e em todo check-in. O TTL é curto de propósito — alerta de segurança
 * desatualizado é pior que ausência de cache.
 */

export const CACHE_KEYS = {
  /** Alertas agregados do pet — a mesma chave que o pet-service invalida. */
  alerts: (tenantId: string, petId: string) => `pront:alerts:${tenantId}:${petId}`,
  pet: (tenantId: string, petId: string) => `pet:${tenantId}:${petId}`,
} as const

export const CACHE_TTL_SECONDS = {
  /** Curto: RN-02 exige alerta fresco na agenda e no check-in. */
  alerts: 120,
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
 * Invalida o alerta do pet **e** o cache do próprio pet, que embute `alerts[]`.
 *
 * A segunda chave é de outro serviço, e isso é deliberado: o evento
 * `prontuario.alerta.alterado` também invalida lá, mas o consumidor é assíncrono.
 * Apagar aqui, na hora, evita a janela em que a ficha do pet ainda mostra a alergia
 * que acabou de ser desativada — dois segundos de alerta errado bastam para alguém
 * usar o shampoo errado.
 */
export async function invalidateAlerts(tenantId: string, petId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.alerts(tenantId, petId), CACHE_KEYS.pet(tenantId, petId))
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined)
  client = null
}
