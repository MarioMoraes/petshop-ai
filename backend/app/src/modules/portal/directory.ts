import { listPortalDirectory } from '@petshop/db'
import {
  isPortalVisibleStatus,
  planIncludes,
  PORTAL_DIRECTORY_LIMIT,
  type Plan,
  type PortalDirectoryEntry,
  type PortalDirectoryResponse,
} from '@petshop/shared-types'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../../shared/redis.js'
import { withinRate } from './rate-limit.js'

/**
 * O catálogo de estabelecimentos da primeira tela do app do tutor.
 *
 * **É a única rota do produto que enumera tenants.** O que a contém é o critério, e ele
 * é palavra por palavra o que `resolvePortalTenant` aceita: estado da conta visível,
 * plano com Portal e o interruptor ligado nas configurações. Repetir a regra é o que
 * impede a lista de oferecer um petshop que a tela seguinte responderia com 404 — e o
 * dia em que uma das três mudar, as duas mudam juntas porque leem os mesmos helpers.
 *
 * O que desce é o que está na fachada: nome, endereço do site, logo e cor. Nada de
 * telefone, nada de endereço, nada de operação — quem quiser a vitrine do
 * estabelecimento abre o site dele, que é onde ela mora.
 */
export async function readPortalDirectory(): Promise<PortalDirectoryResponse> {
  const cached = await cacheGet<PortalDirectoryResponse>(CACHE_KEYS.portalDirectory())
  if (cached) return cached

  // O teto é pedido com um a mais: é assim que se sabe que havia mais sem contar tudo.
  const rows = await listPortalDirectory(PORTAL_DIRECTORY_LIMIT + 1)

  const elegiveis = rows.filter(
    (row) => isPortalVisibleStatus(row.status) && planIncludes(row.plan as Plan, 'PORTAL'),
  )

  const payload: PortalDirectoryResponse = {
    tenants: elegiveis.slice(0, PORTAL_DIRECTORY_LIMIT).map(toEntry),
    truncated: elegiveis.length > PORTAL_DIRECTORY_LIMIT,
  }

  await cacheSet(CACHE_KEYS.portalDirectory(), payload, CACHE_TTL_SECONDS.portalDirectory)
  return payload
}

function toEntry(row: { slug: string; name: string; branding: unknown }): PortalDirectoryEntry {
  const branding = (row.branding ?? {}) as Record<string, unknown>
  return {
    slug: row.slug,
    name: row.name,
    logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
    brandColor: typeof branding.primaryColor === 'string' ? branding.primaryColor : null,
  }
}

/**
 * Teto do catálogo, por IP.
 *
 * **`/public/` está fora do balde geral do app**, e a razão está escrita em `app.ts`: em
 * produção quem chama aquele prefixo é o servidor do Next, com um IP só, e um teto por
 * IP juntaria o site de todos os tenants numa cota comum. Esta rota quebra a premissa —
 * quem chama é o aparelho de cada tutor, com o IP dele —, então ela se defende sozinha,
 * como o formulário do site faz.
 *
 * Contador indisponível **libera**: o catálogo é leitura de dado de fachada e já tem
 * cache de cinco minutos; trancar a primeira tela do app porque o Redis caiu seria
 * trocar um risco pequeno por uma porta fechada.
 */
const RATE_LIMIT = { max: 30, windowSeconds: 60 }

export function withinDirectoryRateLimit(ip: string): Promise<boolean> {
  return withinRate(
    CACHE_KEYS.portalDirectoryRate(ip),
    RATE_LIMIT.max,
    RATE_LIMIT.windowSeconds,
    true,
  )
}
