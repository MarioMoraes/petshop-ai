import { PORTAL_CHALLENGE_RATE, PORTAL_COOLDOWN_MIN } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { CACHE_KEYS, getRedis } from '../../shared/redis.js'
import { logger } from '../../shared/logger.js'

/**
 * Os tetos da porta pública (AC-01 de MOD-PORTAL-11).
 *
 * **Duas janelas, e não uma.** Só por IP, o NAT de uma operadora bloqueia um bairro
 * inteiro; só por identificador, um script que rotaciona e-mails passa livre. As duas
 * juntas é que fecham: quem insiste no mesmo contato bate no primeiro teto, e quem varre
 * contatos bate no segundo.
 *
 * **Redis indisponível barra o pedido**, ao contrário do formulário do site, que libera.
 * A escolha inverte porque o que está do outro lado inverte: lá, um lead perdido é um
 * cliente perdido; aqui, sem teto, seis dígitos caem por força bruta. Quem não consegue
 * o código tenta de novo em um minuto.
 *
 * `DISABLE_REDIS` é outra coisa, e não deve ser confundida com falha: é a instalação
 * dizendo que não há Redis — desenvolvimento e suíte de teste. Aí o contador vive em
 * memória. Está errado para produção, porque não atravessa réplicas, e é justamente por
 * isso que a variável nunca é ligada lá.
 */

export type RateVerdict = 'OK' | 'IDENTIFIER' | 'IP' | 'COOLDOWN' | 'UNAVAILABLE'

interface RateStore {
  bump(key: string, windowSeconds: number): Promise<number>
  has(key: string): Promise<boolean>
  hold(key: string, seconds: number): Promise<void>
}

const memory = new Map<string, { value: number; expiresAt: number }>()

const memoryStore: RateStore = {
  async bump(key, windowSeconds) {
    const now = Date.now()
    const current = memory.get(key)
    if (!current || current.expiresAt <= now) {
      memory.set(key, { value: 1, expiresAt: now + windowSeconds * 1000 })
      return 1
    }
    current.value += 1
    return current.value
  },
  async has(key) {
    const current = memory.get(key)
    return current !== undefined && current.expiresAt > Date.now()
  },
  async hold(key, seconds) {
    memory.set(key, { value: 1, expiresAt: Date.now() + seconds * 1000 })
  },
}

function redisStore(): RateStore | null {
  const redis = getRedis()
  if (!redis) return null

  return {
    async bump(key, windowSeconds) {
      const count = await redis.incr(key)
      // Só a primeira do período define a janela; renovar o TTL a cada pedido faria a
      // janela deslizar para sempre e quem foi barrado nunca sair do bloqueio.
      if (count === 1) await redis.expire(key, windowSeconds)
      return count
    },
    async has(key) {
      return (await redis.get(key)) !== null
    },
    async hold(key, seconds) {
      await redis.set(key, '1', 'EX', seconds)
    },
  }
}

function resolveStore(): RateStore | null {
  return loadEnv().DISABLE_REDIS ? memoryStore : redisStore()
}

/** Zera o contador em memória. Usado entre testes; sem efeito com Redis de verdade. */
export function resetRateMemory(): void {
  memory.clear()
}

/**
 * Um teto simples por chave, para quem não precisa das duas janelas do desafio.
 *
 * Existe para que o catálogo público não monte um segundo mecanismo de contagem: o
 * `DISABLE_REDIS` da suíte já troca o contador por um em memória aqui, e um contador
 * paralelo em `directory.ts` sempre liberaria no teste — o teto estaria escrito e nunca
 * exercitado, que é como uma regra vira letra morta.
 *
 * `seIndisponivel` é do chamador porque a escolha certa depende do que está do outro
 * lado: o desafio barra (sem teto, seis dígitos caem por força bruta), o catálogo libera
 * (é leitura de dado de fachada, e trancar a primeira tela do app seria pior).
 */
export async function withinRate(
  key: string,
  max: number,
  windowSeconds: number,
  seIndisponivel: boolean,
): Promise<boolean> {
  const store = resolveStore()
  if (!store) return seIndisponivel

  try {
    return (await store.bump(key, windowSeconds)) <= max
  } catch (error) {
    logger.warn({ err: error, key }, 'falha no teto por chave')
    return seIndisponivel
  }
}

export async function checkChallengeRate(
  tenantId: string,
  identifierHash: string,
  ip: string | null,
): Promise<RateVerdict> {
  const store = resolveStore()
  if (!store) return 'UNAVAILABLE'

  try {
    if (await store.has(CACHE_KEYS.portalCooldown(tenantId, identifierHash))) return 'COOLDOWN'

    const byIdentifier = await store.bump(
      CACHE_KEYS.challengeByIdentifier(tenantId, identifierHash),
      PORTAL_CHALLENGE_RATE.perIdentifier.windowMin * 60,
    )
    if (byIdentifier > PORTAL_CHALLENGE_RATE.perIdentifier.max) return 'IDENTIFIER'

    if (ip) {
      const byIp = await store.bump(
        CACHE_KEYS.challengeByIp(tenantId, ip),
        PORTAL_CHALLENGE_RATE.perIp.windowMin * 60,
      )
      if (byIp > PORTAL_CHALLENGE_RATE.perIp.max) return 'IP'
    }

    return 'OK'
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'falha no rate limit do Portal; barrando o pedido')
    return 'UNAVAILABLE'
  }
}

/**
 * O cooldown do AC-05, aplicado quando as cinco tentativas se esgotam.
 *
 * Vale para o **identificador**, e não para o desafio: bloquear só o desafio deixaria o
 * atacante pedir um código novo e recomeçar a contagem — cinco tentativas por pedido,
 * sem limite de pedidos, é o mesmo que não ter teto.
 */
export async function startCooldown(tenantId: string, identifierHash: string): Promise<void> {
  const store = resolveStore()
  if (!store) return

  try {
    await store.hold(CACHE_KEYS.portalCooldown(tenantId, identifierHash), PORTAL_COOLDOWN_MIN * 60)
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'falha ao gravar cooldown do Portal')
  }
}
