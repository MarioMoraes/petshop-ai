import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD portal_tutor_09 §10.
 *
 * **Nada com dado pessoal entra aqui** (RN-16): o que se guarda é configuração do
 * tenant e contador de rate limit. O extrato, a ficha e a agenda do tutor são lidos sob
 * demanda dos serviços de domínio, a cada requisição.
 */

export const CACHE_KEYS = {
  tenantFeatures: (tenantId: string) => `portal:features:${tenantId}`,
  /** Balde por identificador. A chave é o **hash**, nunca o e-mail ou o telefone. */
  challengeByIdentifier: (tenantId: string, identifierHash: string) =>
    `portal:rl:id:${tenantId}:${identifierHash}`,
  challengeByIp: (tenantId: string, ip: string) => `portal:rl:ip:${tenantId}:${ip}`,
  /** Cooldown do AC-05, depois de esgotadas as tentativas. */
  cooldown: (tenantId: string, identifierHash: string) =>
    `portal:cooldown:${tenantId}:${identifierHash}`,
} as const

export const CACHE_TTL_SECONDS = {
  tenantFeatures: 300,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})
