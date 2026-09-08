import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../config/env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD §10. Compartilhado entre réplicas — é o que permite que a verificação
 * de permissão fique no p95 de 15ms com cache quente.
 *
 * Toda operação degrada em silêncio: Redis fora do ar deixa o processo mais lento,
 * nunca indisponível.
 *
 * **As chaves são namespaced por módulo e o namespace é contrato.** Elas atravessam
 * processos hoje (os serviços que ainda não migraram invalidam chave daqui) e vão
 * continuar atravessando réplicas depois. Renomear uma é uma migração, não um refino.
 */

export const CACHE_KEYS = {
  jwks: 'clerk:jwks',
  permissions: (tenantId: string, userId: string) => `perm:${tenantId}:${userId}`,
  tenantByOrg: (clerkOrgId: string) => `tenant:org:${clerkOrgId}`,
  tenantStatus: (tenantId: string) => `tenant:status:${tenantId}`,
  userByClerkId: (clerkUserId: string) => `user:clerk:${clerkUserId}`,
  /**
   * Namespace `portal:` de propósito. O identity-service já declara um
   * `tenant:slug:{slug}`, e duas chaves com o mesmo nome e formatos diferentes é o tipo
   * de colisão que só aparece quando as duas estão quentes ao mesmo tempo.
   */
  portalTenantBySlug: (slug: string) => `portal:tenant:${slug}`,
  /**
   * A sessão do Portal. **O nome é contrato entre serviços**, como o `perm:` que o
   * identity-service invalida: o tutor-service apaga esta chave ao desvincular o acesso,
   * e é o que faz o AC-05 de MOD-PORTAL-02 valer antes do TTL.
   */
  portalSession: (tenantId: string, userId: string) => `portal:session:${tenantId}:${userId}`,

  // ---- MOD-SITE ----
  publicSite: (tenantId: string) => `site:public:${tenantId}`,
  host: (slug: string) => `site:host:${slug}`,
  /**
   * **O cache negativo não é detalhe.** Sem ele, um bot varrendo subdomínios
   * inexistentes vira uma consulta ao banco por requisição — e o único jeito de
   * descobrir que `xyz.dominio` não existe é perguntar. Com ele, vira uma consulta a
   * cada cinco minutos por host.
   */
  hostMiss: (slug: string) => `site:host:miss:${slug}`,
  leadRate: (tenantId: string, ip: string) => `site:rl:${tenantId}:${ip}`,

  // ---- MOD-TAXI ----
  zones: (tenantId: string) => `taxi:zones:${tenantId}`,
  vehicles: (tenantId: string) => `taxi:vehicles:${tenantId}`,
  taxiSettings: (tenantId: string) => `taxi:settings:${tenantId}`,
  board: (tenantId: string, date: string) => `taxi:board:${tenantId}:${date}`,
  route: (tenantId: string, driverId: string, date: string) =>
    `taxi:route:${tenantId}:${driverId}:${date}`,
} as const

export const CACHE_TTL_SECONDS = {
  jwks: 3600,
  permissions: 300,
  tenantByOrg: 3600,
  tenantStatus: 60,
  userByClerkId: 300,
  portalTenantBySlug: 3600,
  /**
   * Curto de propósito. É o mecanismo que substitui o `permVersion` na sessão do
   * Portal: o claim vem do metadata do membership no Clerk, e o tutor não tem
   * membership. Desvincular o acesso apaga esta chave; o minuto é o pior caso de quem
   * revoga com a chave já apagada por outra réplica (AC-05 de MOD-PORTAL-02).
   */
  portalSession: 60,

  publicSite: 600,
  host: 3600,
  hostMiss: 300,

  zones: 3600,
  vehicles: 3600,
  taxiSettings: 3600,
  board: 20,
  /**
   * O TTL mais curto do sistema, de propósito: a rota do motorista é recarregada em
   * rede móvel a cada parada, e rota velha manda o motorista para o endereço errado.
   */
  route: 15,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

/**
 * Descarta o payload montado de um tenant.
 *
 * Chamado por toda escrita do módulo do site e pelos consumidores de
 * `tenant.configuracao.atualizada` e `agenda.servico.alterado` — o horário corrigido
 * às 9h não pode aparecer ao meio-dia (AC-02 de MOD-SITE-06).
 */
export async function invalidateSite(tenantId: string, slug?: string): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.publicSite(tenantId),
    ...(slug ? [CACHE_KEYS.host(slug), CACHE_KEYS.hostMiss(slug)] : []),
  )
}

/**
 * A configuração e as zonas decidem preço (MOD-TAXI).
 *
 * Uma zona alterada com o cache quente cobraria o valor antigo na próxima corrida — e
 * o preço congela na criação (RN-07), então o erro seria permanente naquela corrida,
 * não transitório.
 */
export async function invalidatePricing(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.zones(tenantId), CACHE_KEYS.taxiSettings(tenantId))
}
