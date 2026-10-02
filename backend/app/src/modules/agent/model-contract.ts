import type Anthropic from '@anthropic-ai/sdk'

/**
 * O contrato dos provedores de modelo — o ponto de troca do módulo.
 *
 * Mora fora de `model-port.ts` porque o seletor importa o cliente, e o cliente
 * importaria o seletor de volta só para alcançar os tipos.
 *
 * **O vocabulário é o da Anthropic**, herdado de quando ela era o provedor de produção
 * (até 2026-10-02). O runner, as tools e os testes falam esse dialeto, e o cliente do
 * Gemini traduz nas duas pontas — trocar o vocabulário junto com o provedor mexeria em
 * tudo o que já estava afinado para ganhar nada que o usuário veja.
 */

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Preço por token, na mesma unidade de `agent_turns.cost_millicents`. */
export interface TokenRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * O câmbio é uma constante e não uma cotação.
 *
 * O número existe para o teto de gasto e para o painel de qualidade, e uma conta que
 * mudasse de resultado entre dois turnos da mesma conversa seria pior que uma aproximação
 * estável. Quem precisa do valor exato tem a fatura do provedor.
 */
const AGENT_USD_BRL = 5.5

/** De dólar por milhão de tokens para milésimo de centavo de real por token. */
export function ratesFor(usdPerMTok: TokenRates): TokenRates {
  const convert = (usd: number): number => (usd * AGENT_USD_BRL * 100_000) / 1_000_000
  return {
    input: convert(usdPerMTok.input),
    output: convert(usdPerMTok.output),
    cacheRead: convert(usdPerMTok.cacheRead),
    cacheWrite: convert(usdPerMTok.cacheWrite),
  }
}

/**
 * O preço do `claude-opus-5`, que era o provedor de produção, é o **padrão** de quem não
 * declara o seu.
 *
 * Vale para os dublês da suíte, que implementam a porta sem tarifa: os testes de custo
 * foram escritos contra estes números, e um dublê sem preço passaria a custar zero em
 * silêncio — que é justamente o que a coluna `cost_millicents` existe para não deixar
 * acontecer.
 */
export const DEFAULT_RATES = ratesFor({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })

export interface ModelRequest {
  /** O prefixo estável: prompt de sistema + contexto do tenant. */
  system: string
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  /** `true` no turno final, quando a resposta precisa sair no formato estruturado. */
  structured: boolean
}

export interface ModelResponse {
  content: Anthropic.ContentBlock[]
  stopReason: string | null
  usage: ModelUsage
}

export interface ModelPort {
  configured: boolean
  /** A tarifa do provedor. Ausente, vale a de `DEFAULT_RATES`. */
  rates?: TokenRates
  complete(request: ModelRequest): Promise<ModelResponse>
}

/**
 * O provedor recusou a **chave** — revogada, sem permissão, sem crédito.
 *
 * Separada das outras falhas porque não passa sozinha: o provedor fora do ar volta no
 * minuto seguinte, a chave revogada não. O runner a grava em `agent_settings.api_key_error`
 * para a tela do petshop dizer o que fazer, em vez de o agente simplesmente parar.
 */
export class ModelKeyRejectedError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ModelKeyRejectedError'
  }
}
