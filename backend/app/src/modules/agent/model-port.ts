import { createHash } from 'node:crypto'
import { loadEnv } from '../../config/env.js'
import { readTenantApiKey } from './api-key.js'
import { providerUnavailable } from './errors.js'
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
 * **A porta é por estabelecimento.** Cada petshop cadastra a própria chave do Google
 * Gemini em Configurações › Integrações e paga o próprio consumo; sem ela, o agente
 * responde como desligado. A chave da instalação (`GEMINI_API_KEY`) **só vale fora de
 * produção** — é o que deixa o `pnpm dev` exercitar o agente sem cadastrar nada, e o que
 * impede um petshop de gastar o crédito da plataforma por esquecimento de configuração.
 *
 * A mesma chave transcreve o áudio (`transcription.ts`), e é `resolveModelKey` que
 * decide qual vale para as duas coisas.
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

export interface ModelKey {
  apiKey: string
  /** Identifica o cliente já montado: muda quando a chave muda. */
  fingerprint: string
}

/**
 * A chave que responde por este estabelecimento: a dele, ou — fora de produção — a da
 * instalação.
 *
 * A ausência é estado legítimo (AC-02 de MOD-AI-07), e não erro: quem chama devolve uma
 * porta não configurada.
 */
export async function resolveModelKey(tenantId: string): Promise<ModelKey | null> {
  const tenantKey = await readTenantApiKey(tenantId)
  if (tenantKey) {
    return {
      apiKey: tenantKey.apiKey,
      fingerprint: createHash('sha256').update(tenantKey.encrypted).digest('hex'),
    }
  }

  const env = loadEnv()
  if (env.NODE_ENV === 'production' || !env.GEMINI_API_KEY) return null
  return { apiKey: env.GEMINI_API_KEY, fingerprint: 'development' }
}

/** O dublê dos testes: quando presente, responde por todos os tenants. */
let override: ModelPort | null = null

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

  const key = await resolveModelKey(tenantId)
  if (!key) return unconfiguredPort

  let port = byKey.get(key.fingerprint)
  if (!port) {
    if (byKey.size >= MAX_CACHED_CLIENTS) byKey.clear()
    port = createGeminiPort(key.apiKey)
    byKey.set(key.fingerprint, port)
  }
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setModelPort(next: ModelPort | null): void {
  override = next
  byKey.clear()
}
