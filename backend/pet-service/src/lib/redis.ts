import { createCache } from '@petshop/service-kit'
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

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

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
