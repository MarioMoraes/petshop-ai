import { Redis } from 'ioredis'
import type { Logger } from 'pino'

/**
 * Cache Redis dos PRDs §10.
 *
 * A regra que governa o arquivo inteiro: **falha de cache nunca derruba requisição**.
 * Toda leitura degrada para o banco e toda escrita é best-effort — Redis fora do ar
 * deixa o serviço mais lento, nunca indisponível. Por isso todo método engole a
 * exceção e apenas avisa no log.
 *
 * O que cada serviço guarda (as chaves e os TTLs) fica no serviço: são decisão de
 * domínio, não de mecanismo.
 */

export interface CacheConfig {
  logger: Logger
  /**
   * Lidos a cada chamada, e não uma vez na construção, porque `loadEnv()` é
   * memoizado sob demanda e os testes o resetam entre casos.
   */
  getUrl: () => string
  isDisabled: () => boolean
}

export interface ServiceCache {
  getRedis: () => Redis | null
  cacheGet: <T>(key: string) => Promise<T | null>
  cacheSet: (key: string, value: unknown, ttlSeconds: number) => Promise<void>
  cacheDelete: (...keys: string[]) => Promise<void>
  closeRedis: () => Promise<void>
}

export function createCache(config: CacheConfig): ServiceCache {
  const { logger } = config
  let client: Redis | null = null

  function getRedis(): Redis | null {
    if (config.isDisabled()) return null
    client ??= new Redis(config.getUrl(), {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    }).on('error', (error) => {
      logger.warn({ err: error }, 'Erro no Redis — seguindo sem cache')
    })
    return client
  }

  return {
    getRedis,

    async cacheGet<T>(key: string): Promise<T | null> {
      try {
        const raw = await getRedis()?.get(key)
        return raw ? (JSON.parse(raw) as T) : null
      } catch (error) {
        logger.warn({ err: error, key }, 'Falha ao ler do cache')
        return null
      }
    },

    async cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      try {
        await getRedis()?.set(key, JSON.stringify(value), 'EX', ttlSeconds)
      } catch (error) {
        logger.warn({ err: error, key }, 'Falha ao gravar no cache')
      }
    },

    async cacheDelete(...keys: string[]): Promise<void> {
      if (keys.length === 0) return
      try {
        await getRedis()?.del(...keys)
      } catch (error) {
        logger.warn({ err: error, keys }, 'Falha ao invalidar o cache')
      }
    },

    async closeRedis(): Promise<void> {
      await client?.quit().catch(() => undefined)
      client = null
    },
  }
}
