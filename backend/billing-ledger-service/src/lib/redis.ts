import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD financeiro_tutor_05 §10. Falha de cache nunca derruba requisição.
 *
 * **O saldo nunca é servido do cache em operação de escrita.** Lançamento, pagamento e
 * consumo de crédito leem a conta com `SELECT … FOR UPDATE` direto no Postgres. O
 * cache existe para leitura de tela, onde alguns segundos de defasagem custam menos
 * que a latência somada em cada abertura da ficha do tutor.
 */

export const CACHE_KEYS = {
  balance: (tenantId: string, tutorId: string) => `ledger:balance:${tenantId}:${tutorId}`,
  packages: (tenantId: string, tutorId: string) => `ledger:packages:${tenantId}:${tutorId}`,
  settings: (tenantId: string) => `ledger:settings:${tenantId}`,
} as const

export const CACHE_TTL_SECONDS = {
  balance: 60,
  packages: 300,
  settings: 900,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

/**
 * Invalidação **ativa** do saldo, não só por TTL.
 *
 * Sessenta segundos de defasagem são aceitáveis para quem abre a ficha; não são para
 * quem acabou de registrar o pagamento e olha para a tela esperando o saldo zerar.
 */
export async function invalidateAccount(tenantId: string, tutorId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.balance(tenantId, tutorId))
}

/** Muda um pacote → some o saldo junto: compra e resgate mexem nos dois. */
export async function invalidatePackages(tenantId: string, tutorId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.packages(tenantId, tutorId), CACHE_KEYS.balance(tenantId, tutorId))
}

export async function invalidateSettings(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.settings(tenantId))
}
