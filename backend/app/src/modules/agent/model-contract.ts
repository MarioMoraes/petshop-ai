import type Anthropic from '@anthropic-ai/sdk'

/**
 * O contrato dos provedores de modelo — o ponto de troca do módulo.
 *
 * Ficava dentro de `model-port.ts` enquanto havia um implementador só. Com o segundo
 * (Gemini), deixar o contrato no arquivo que também **escolhe** o provedor criaria um
 * ciclo: o seletor importa os clientes, e os clientes importariam o seletor de volta só
 * para alcançar os tipos. Aqui os dois clientes são pares, e nenhum depende do outro.
 *
 * **O vocabulário é o da Anthropic**, e isso é deliberado. Um formato neutro inventado
 * aqui obrigaria os dois clientes a traduzir, e o de produção pagaria tradução para nada.
 * O cliente do Gemini traduz nas duas pontas; o custo fica em quem é a exceção.
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
 * O preço da Anthropic é o **padrão** de quem não declara o seu.
 *
 * Vale para os dublês da suíte, que implementam a porta sem tarifa: os testes de custo
 * foram escritos contra estes números, e um dublê sem preço passaria a custar zero em
 * silêncio — que é justamente o que a coluna `cost_millicents` existe para não deixar
 * acontecer.
 */
export const DEFAULT_RATES = ratesFor({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })

export interface ModelRequest {
  /** O prefixo estável: prompt de sistema + contexto do tenant. Vai com `cache_control`. */
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
  /** A tarifa do provedor. Ausente, vale a da Anthropic — ver `DEFAULT_RATES`. */
  rates?: TokenRates
  complete(request: ModelRequest): Promise<ModelResponse>
}
