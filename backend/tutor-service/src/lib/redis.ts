import { createCache } from '@petshop/service-kit'
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

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

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
