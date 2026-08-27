import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD taxi_dog_07 §10. Falha de cache nunca derruba requisição: toda
 * leitura degrada para o banco e toda escrita é best-effort.
 *
 * A rota do motorista tem o TTL mais curto do sistema (15s) de propósito: ela é
 * recarregada em rede móvel a cada parada, e rota velha manda o motorista para o
 * endereço errado.
 */

export const CACHE_KEYS = {
  zones: (tenantId: string) => `taxi:zones:${tenantId}`,
  vehicles: (tenantId: string) => `taxi:vehicles:${tenantId}`,
  settings: (tenantId: string) => `taxi:settings:${tenantId}`,
  board: (tenantId: string, date: string) => `taxi:board:${tenantId}:${date}`,
  route: (tenantId: string, driverId: string, date: string) =>
    `taxi:route:${tenantId}:${driverId}:${date}`,
} as const

export const CACHE_TTL_SECONDS = {
  zones: 3600,
  vehicles: 3600,
  settings: 3600,
  board: 20,
  route: 15,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

/**
 * A configuração e as zonas decidem preço. Uma zona alterada com o cache quente
 * cobraria o valor antigo na próxima corrida — e o preço congela na criação (RN-07),
 * então o erro seria permanente naquela corrida, não transitório.
 */
export async function invalidatePricing(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.zones(tenantId), CACHE_KEYS.settings(tenantId))
}
