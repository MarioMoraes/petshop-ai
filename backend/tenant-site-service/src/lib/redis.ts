import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD site_tenant_10 §10. Falha de cache nunca derruba requisição: toda
 * leitura degrada para o banco e toda escrita é best-effort.
 *
 * **O cache negativo não é detalhe.** Sem `hostMiss`, um bot varrendo subdomínios
 * inexistentes vira uma consulta ao banco por requisição — e o único jeito de
 * descobrir que `xyz.dominio` não existe é perguntar. Com ele, vira uma consulta a
 * cada cinco minutos por host.
 */

export const CACHE_KEYS = {
  publicSite: (tenantId: string) => `site:public:${tenantId}`,
  host: (slug: string) => `site:host:${slug}`,
  hostMiss: (slug: string) => `site:host:miss:${slug}`,
  leadRate: (tenantId: string, ip: string) => `site:rl:${tenantId}:${ip}`,
} as const

export const CACHE_TTL_SECONDS = {
  publicSite: 600,
  host: 3600,
  hostMiss: 300,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

/**
 * Descarta o payload montado de um tenant.
 *
 * Chamado por toda escrita do próprio serviço e pelos consumidores de
 * `tenant.configuracao.atualizada` e `agenda.servico.alterado` — o horário corrigido
 * às 9h não pode aparecer ao meio-dia (AC-02 de MOD-SITE-06).
 */
export async function invalidateSite(tenantId: string, slug?: string): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.publicSite(tenantId),
    ...(slug ? [CACHE_KEYS.host(slug), CACHE_KEYS.hostMiss(slug)] : []),
  )
}
