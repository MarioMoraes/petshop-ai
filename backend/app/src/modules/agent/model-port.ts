import { loadEnv } from '../../config/env.js'
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
 * **Há dois implementadores**, escolhidos por `AI_PROVIDER`: `model-anthropic.ts` é o
 * alvo de produção e `model-gemini.ts` existe para desenvolvimento, porque o free tier do
 * Google AI Studio deixa exercitar o agente inteiro sem conta paga. O contrato que os
 * dois cumprem está em `model-contract.ts`; este arquivo só escolhe e cobra.
 */

export {
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type TokenRates,
} from './model-contract.js'

/** RN-13: o custo sai do `usage` da resposta, nunca de estimativa. */
export function costOf(usage: ModelUsage): number {
  const rates = getModelPort().rates ?? DEFAULT_RATES
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
 * A escolha do provedor, num ponto só.
 *
 * Cada cliente devolve `null` quando lhe falta a chave, e não uma porta que estoura na
 * primeira chamada: a ausência de credencial é estado legítimo (AC-02 de MOD-AI-07), e
 * quem a traduz em "agente desligado" é aqui.
 */
function createInProcessPort(): ModelPort {
  const env = loadEnv()
  const created = env.AI_PROVIDER === 'gemini' ? createGeminiPort() : createAnthropicPort()
  return created ?? unconfiguredPort
}

let port: ModelPort | null = null

export function getModelPort(): ModelPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setModelPort(next: ModelPort | null): void {
  port = next
}
