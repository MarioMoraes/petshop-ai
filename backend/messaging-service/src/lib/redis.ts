import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache e contadores do PRD relacionamento_crm_08 §10.
 *
 * Falha de cache nunca derruba requisição: toda leitura degrada para o banco e toda
 * escrita é best-effort. Os **contadores de vazão** são a exceção interessante: sem
 * Redis eles não contam, e o motor passa a enviar sem teto. É o comportamento certo
 * para o e-mail (o Resend tem limite próprio) e o motivo pelo qual o teto do WhatsApp,
 * na fatia 2, não pode depender só disto — ver a nota em `dispatch.ts`.
 */

export const CACHE_KEYS = {
  settings: (tenantId: string) => `msgcfg:${tenantId}`,
  template: (tenantId: string, key: string, channel: string) => `tpl:${tenantId}:${key}:${channel}`,
  consent: (tenantId: string, tutorId: string) => `consent:${tenantId}:${tutorId}`,
  /** Janela de um minuto; a chave morre sozinha. */
  rate: (tenantId: string, minute: string) => `msgrate:${tenantId}:${minute}`,
  /** Teto diário, no dia civil do fuso do tenant. */
  dailyCap: (tenantId: string, date: string) => `msgcap:${tenantId}:${date}`,
} as const

export const CACHE_TTL_SECONDS = {
  settings: 600,
  template: 600,
  /**
   * Cinco minutos, e não uma hora: o consentimento é o que separa "mandar" de "não
   * mandar", e um opt-out registrado no balcão precisa valer antes que o tutor
   * reclame de novo. Invalidado também por `tutor.updated` (RN-02).
   */
  consent: 300,
  rate: 120,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

/**
 * Consome uma vaga na janela do minuto corrente. Devolve `false` quando o teto já foi
 * atingido — e `true` quando não há Redis, porque bloquear o envio inteiro por falta
 * de cache seria trocar uma degradação por uma parada.
 */
export async function consumeRateSlot(tenantId: string, perMinuteCap: number): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return true

  const minute = new Date().toISOString().slice(0, 16)
  const key = CACHE_KEYS.rate(tenantId, minute)
  try {
    const used = await redis.incr(key)
    if (used === 1) await redis.expire(key, CACHE_TTL_SECONDS.rate)
    return used <= perMinuteCap
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'falha ao contar vazão — seguindo sem teto')
    return true
  }
}

/**
 * Teto diário, cobrado **só de MARKETING** (RN-05): lembrete e aviso de taxi não
 * podem ser represados por um teto pensado para campanha.
 */
export async function consumeDailySlot(
  tenantId: string,
  date: string,
  dailyCap: number,
): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return true

  const key = CACHE_KEYS.dailyCap(tenantId, date)
  try {
    const used = await redis.incr(key)
    // 36h de vida: cobre o dia civil inteiro em qualquer fuso sem precisar calcular a
    // virada, e a chave do dia seguinte é outra.
    if (used === 1) await redis.expire(key, 129_600)
    return used <= dailyCap
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'falha ao contar teto diário — seguindo sem teto')
    return true
  }
}

export async function invalidateSettings(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.settings(tenantId))
}

export async function invalidateConsent(tenantId: string, tutorId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.consent(tenantId, tutorId))
}
