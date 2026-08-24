import { createCache } from '@petshop/service-kit'
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

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

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
