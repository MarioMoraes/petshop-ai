import { createHash } from 'node:crypto'
import { loadEnv } from '../../config/env.js'
import { readTenantApiKey } from './api-key.js'
import { providerUnavailable } from './errors.js'
import { createAnthropicPort } from './model-anthropic.js'
import { createGeminiPort } from './model-gemini.js'
import { DEFAULT_RATES, type ModelPort, type ModelUsage } from './model-contract.js'

/**
 * O provedor do modelo, atrás de uma porta (§10 do PRD).
 *
 * O mesmo desenho do `ClerkPort` e do `MailerPort`, e pela mesma razão: **a suíte inteira
 * roda sem chave de provedor e sem gastar dinheiro**. O dublê dos testes responde com
 * turnos roteirizados — "chame esta tool, depois responda isto" — e o que fica de fora do
 * teste é só o HTTP.
 *
 * A porta é **fina de propósito**: uma chamada, uma resposta. O laço de tools, a
 * contabilidade de custo e a decisão de handoff ficam do lado de cá, em `runner.ts`. Uma
 * porta que embrulhasse o laço inteiro esconderia justamente o que este módulo faz de
 * arriscado — e o dublê não conseguiria exercitar as tools de verdade.
 *
 * **A porta é por estabelecimento.** Cada petshop cadastra a própria chave da Anthropic
 * em Configurações › Integrações e paga o próprio consumo; sem ela, o agente responde
 * como desligado. A chave da instalação (`ANTHROPIC_API_KEY`, ou o Gemini de
 * `AI_PROVIDER=gemini`) **só vale fora de produção** — é o que deixa o `pnpm dev` exercitar
 * o agente sem cadastrar nada, e o que impede um petshop de gastar o crédito da
 * plataforma por esquecimento de configuração.
 */

export {
  ModelKeyRejectedError,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type TokenRates,
} from './model-contract.js'

/** RN-13: o custo sai do `usage` da resposta, nunca de estimativa. */
export function costOf(usage: ModelUsage, port: ModelPort): number {
  const rates = port.rates ?? DEFAULT_RATES
  return Math.round(
    usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheReadTokens * rates.cacheRead +
      usage.cacheWriteTokens * rates.cacheWrite,
  )
}

/** Sem chave, o módulo se comporta como um agente desligado — e o diz. */
const unconfiguredPort: ModelPort = {
  configured: false,
  async complete() {
    throw providerUnavailable('O provedor do modelo não está configurado')
  },
}

/**
 * A chave da instalação, só para desenvolvimento.
 *
 * Cada cliente devolve `null` quando lhe falta a chave, e não uma porta que estoura na
 * primeira chamada: a ausência de credencial é estado legítimo (AC-02 de MOD-AI-07).
 */
function createDevelopmentPort(): ModelPort | null {
  const env = loadEnv()
  if (env.NODE_ENV === 'production') return null
  if (env.AI_PROVIDER === 'gemini') return createGeminiPort()
  return env.ANTHROPIC_API_KEY ? createAnthropicPort(env.ANTHROPIC_API_KEY) : null
}

/** O dublê dos testes: quando presente, responde por todos os tenants. */
let override: ModelPort | null = null

let development: ModelPort | null | undefined

/**
 * Um cliente por chave, e não por chamada.
 *
 * A chave é identificada pela impressão digital do texto cifrado, e não pelo tenant:
 * trocá-la na tela muda o cifrado, e o cliente velho simplesmente deixa de ser achado.
 * Nenhuma invalidação entre processos é necessária — o worker e o app leem a mesma linha.
 */
const byKey = new Map<string, ModelPort>()
const MAX_CACHED_CLIENTS = 500

export async function getModelPort(tenantId: string): Promise<ModelPort> {
  if (override) return override

  const tenantKey = await readTenantApiKey(tenantId)
  if (tenantKey) {
    const fingerprint = createHash('sha256').update(tenantKey.encrypted).digest('hex')
    let port = byKey.get(fingerprint)
    if (!port) {
      if (byKey.size >= MAX_CACHED_CLIENTS) byKey.clear()
      port = createAnthropicPort(tenantKey.apiKey)
      byKey.set(fingerprint, port)
    }
    return port
  }

  if (development === undefined) development = createDevelopmentPort()
  return development ?? unconfiguredPort
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setModelPort(next: ModelPort | null): void {
  override = next
  development = undefined
  byKey.clear()
}
