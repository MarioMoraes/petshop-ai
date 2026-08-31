import { SITE_LEAD_RATE_LIMIT } from '@petshop/shared-types'
import { CACHE_KEYS, getRedis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'

/**
 * Teto do formulário público, por IP e por tenant (AC-03 de MOD-SITE-08).
 *
 * Formulário público sem teto é caixa de spam com custo de banco. O contador é por
 * **tenant e IP**, e não só por IP: dois petshops atrás do mesmo NAT corporativo não
 * têm por que dividir cota.
 *
 * Redis fora do ar **libera o envio**. É a escolha certa entre as duas: um lead
 * perdido é um cliente perdido; um lead a mais de spam é uma linha que a equipe
 * descarta em um clique.
 */
export async function withinRateLimit(tenantId: string, ip: string): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return true

  const key = CACHE_KEYS.leadRate(tenantId, ip)
  try {
    const count = await redis.incr(key)
    // Só a primeira do período define a janela; renovar o TTL a cada envio faria a
    // janela deslizar para sempre e o visitante nunca sair do bloqueio.
    if (count === 1) await redis.expire(key, SITE_LEAD_RATE_LIMIT.windowSeconds)
    return count <= SITE_LEAD_RATE_LIMIT.max
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'falha no rate limit do formulário; liberando')
    return true
  }
}
