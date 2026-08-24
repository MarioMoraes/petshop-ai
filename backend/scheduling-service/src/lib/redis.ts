import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD agenda_operacao_06 §10. Falha de cache nunca derruba requisição.
 *
 * O catálogo é o item com maior retorno: muda quase nunca e é lido em toda abertura
 * do formulário de agendamento e em todo cálculo de disponibilidade. A agenda do dia
 * deliberadamente **não** entra aqui — ela muda a cada check-in, e agenda velha na
 * tela da recepção é pior do que agenda lenta.
 */

export const CACHE_KEYS = {
  services: (tenantId: string) => `agenda:services:${tenantId}`,
  professionals: (tenantId: string) => `agenda:professionals:${tenantId}`,
  schedule: (tenantId: string, professionalId: string) =>
    `agenda:schedule:${tenantId}:${professionalId}`,
} as const

export const CACHE_TTL_SECONDS = {
  services: 3_600,
  professionals: 3_600,
  schedule: 3_600,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

/**
 * Invalida o catálogo inteiro do tenant.
 *
 * Grosso de propósito: mudar um serviço mexe em quem pode executá-lo, e mudar um
 * profissional mexe em que serviços aparecem no seletor. Invalidar as três chaves
 * custa três `DEL` e evita a classe inteira de bug em que a habilitação some da
 * lista mas continua valendo no cálculo.
 */
export async function invalidateCatalog(tenantId: string, professionalIds: string[] = []): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.services(tenantId),
    CACHE_KEYS.professionals(tenantId),
    ...professionalIds.map((id) => CACHE_KEYS.schedule(tenantId, id)),
  )
}
