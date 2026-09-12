import Anthropic from '@anthropic-ai/sdk'
import { AGENT_TURN_OUTPUT_JSON_SCHEMA } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { providerUnavailable } from './errors.js'
import { ratesFor, type ModelPort } from './model-contract.js'

/**
 * O provedor de produção: Anthropic.
 *
 * Morava dentro de `model-port.ts` enquanto havia um implementador só. Com o segundo
 * (Gemini), manter o contrato no arquivo de um dos provedores obrigaria o outro a
 * importar dele — como se um fosse derivado do outro. Aqui os dois são pares, e o
 * contrato mora em `model-port.ts`.
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
 * Preço do `claude-opus-5`, em **dólares por milhão de tokens**.
 *
 * A leitura do cache custa um décimo da entrada; a escrita, 1,25×. A conversão para
 * milésimo de centavo de real fica em `ratesFor`, que é comum aos dois provedores.
 */
const USD_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const

export function createAnthropicPort(): ModelPort | null {
  const env = loadEnv()
  if (!env.ANTHROPIC_API_KEY) return null

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

  return {
    configured: true,
    rates: ratesFor(USD_PER_MTOK),

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
