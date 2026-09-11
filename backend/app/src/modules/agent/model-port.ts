import Anthropic from '@anthropic-ai/sdk'
import { AGENT_TURN_OUTPUT_JSON_SCHEMA } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { providerUnavailable } from './errors.js'

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
 * As decisões do §10, e o que cada uma custa:
 *
 * | Decisão | Escolha | Por quê |
 * |---|---|---|
 * | Modelo | `claude-opus-5` | A conversa é curta e o custo por turno é dominado pelo prefixo em cache, não pela saída |
 * | Thinking | adaptativo, `effort: low` | Atendimento é classificação e consulta, não raciocínio longo |
 * | Tools | `strict: true` | O argumento chega válido e vai direto ao `parseInput` do domínio |
 * | Saída | `output_config.format` | Resposta, sentimento e handoff num turno só; a alternativa é uma segunda chamada por mensagem |
 * | Streaming | não | A resposta vai inteira para o WhatsApp; não há tela onde ela apareça sendo escrita |
 */

export const AGENT_MODEL = 'claude-opus-5'

/**
 * Preço do `claude-opus-5`, em **milésimos de centavo de real por token**.
 *
 * US$ 5 por milhão de tokens de entrada e US$ 25 de saída, convertidos por
 * `AGENT_USD_BRL`. A leitura do cache custa um décimo da entrada; a escrita, 1,25×.
 *
 * O câmbio é uma constante e não uma cotação: o número existe para o teto de gasto e
 * para o painel de qualidade, e uma conta que mudasse de resultado entre dois turnos da
 * mesma conversa seria pior que uma aproximação estável. Quem precisa do valor exato tem
 * a fatura do provedor.
 */
const USD_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const
const AGENT_USD_BRL = 5.5

/** Milésimos de centavo por token, por tipo. */
const MILLICENTS_PER_TOKEN = {
  input: (USD_PER_MTOK.input * AGENT_USD_BRL * 100_000) / 1_000_000,
  output: (USD_PER_MTOK.output * AGENT_USD_BRL * 100_000) / 1_000_000,
  cacheRead: (USD_PER_MTOK.cacheRead * AGENT_USD_BRL * 100_000) / 1_000_000,
  cacheWrite: (USD_PER_MTOK.cacheWrite * AGENT_USD_BRL * 100_000) / 1_000_000,
} as const

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** RN-13: o custo sai do `usage` da resposta, nunca de estimativa. */
export function costOf(usage: ModelUsage): number {
  return Math.round(
    usage.inputTokens * MILLICENTS_PER_TOKEN.input +
      usage.outputTokens * MILLICENTS_PER_TOKEN.output +
      usage.cacheReadTokens * MILLICENTS_PER_TOKEN.cacheRead +
      usage.cacheWriteTokens * MILLICENTS_PER_TOKEN.cacheWrite,
  )
}

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
  complete(request: ModelRequest): Promise<ModelResponse>
}

/** Sem chave, o módulo se comporta como um agente desligado — e o diz. */
const unconfiguredPort: ModelPort = {
  configured: false,
  async complete() {
    throw providerUnavailable('O provedor do modelo não está configurado')
  },
}

function createInProcessPort(): ModelPort {
  const env = loadEnv()
  if (!env.ANTHROPIC_API_KEY) return unconfiguredPort

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

  return {
    configured: true,

    async complete(request) {
      try {
        const response = await client.messages.create({
          model: AGENT_MODEL,
          /**
           * Folgado para o que a resposta é (no máximo 1200 caracteres): o thinking
           * adaptativo também sai deste orçamento, e um teto apertado devolveria
           * `max_tokens` no meio de um raciocínio curto — que é uma resposta perdida e
           * paga.
           */
          max_tokens: 8_000,
          thinking: { type: 'adaptive' },
          system: [
            {
              type: 'text',
              text: request.system,
              /**
               * **O prefixo em cache é o que torna o módulo viável** (§10).
               *
               * A ordem de renderização é `tools` → `system` → `messages`, e o
               * `cache_control` aqui fecha tudo o que é estável: a definição das tools e
               * o contexto do estabelecimento. O que varia por turno — a mensagem do
               * tutor — fica depois. Sem isto, cada turno paga o prompt inteiro de novo
               * e o custo por conversa multiplica pelo número de turnos.
               */
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: request.tools,
          messages: request.messages,
          output_config: {
            /**
             * Atendimento é classificação e consulta, não raciocínio longo. `low` é onde
             * a qualidade se mantém e o custo cai.
             */
            effort: 'low',
            ...(request.structured
              ? { format: { type: 'json_schema' as const, schema: AGENT_TURN_OUTPUT_JSON_SCHEMA } }
              : {}),
          },
        })

        return {
          content: response.content,
          stopReason: response.stop_reason,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
          },
        }
      } catch (error) {
        /**
         * **Nada disto chega ao tutor como erro** (RN-09). Quem trata é o `runner.ts`,
         * que manda a conversa para a recepção — "vou chamar alguém" é uma resposta;
         * `ERR_AI_006` não é.
         */
        if (error instanceof Anthropic.RateLimitError) {
          throw providerUnavailable('O provedor do modelo recusou por excesso de chamadas')
        }
        if (error instanceof Anthropic.AuthenticationError) {
          throw providerUnavailable('A chave do provedor do modelo foi recusada')
        }
        if (error instanceof Anthropic.APIError) {
          throw providerUnavailable(`O provedor do modelo respondeu ${error.status}`)
        }
        throw providerUnavailable('O provedor do modelo não respondeu')
      }
    },
  }
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
