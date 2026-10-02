import {
  ApiError,
  GoogleGenAI,
  MediaModality,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from '@google/genai'
import type Anthropic from '@anthropic-ai/sdk'
import { AGENT_TURN_OUTPUT_JSON_SCHEMA } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'
import { providerUnavailable } from './errors.js'
import {
  ModelKeyRejectedError,
  ratesFor,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from './model-contract.js'

/**
 * O provedor do modelo: Google Gemini.
 *
 * Foi o provedor de desenvolvimento enquanto a Anthropic atendia a produção; desde
 * 2026-10-02 é o único. Cada petshop cadastra a própria chave do Google AI Studio em
 * Integrações, e é ela que chega a `createGeminiPort` — o mesmo cliente responde o turno
 * e transcreve o áudio (`createGeminiTranscriber`), então uma chave só liga as duas coisas.
 *
 * Este arquivo é **só tradução e uma chamada**. O laço de tools continua no `runner.ts`:
 * a porta é fina, e o Gemini não ganha um laço próprio só porque o SDK dele não traz um.
 *
 * **O vocabulário do contrato continua o da Anthropic** (`model-contract.ts`), herdado de
 * quando ela era o provedor de produção. O prompt, as tools e o runner foram escritos
 * contra ele, e trocá-lo junto com o provedor mexeria em tudo o que já estava afinado;
 * a tradução fica aqui, nas duas pontas.
 *
 * ## As três diferenças que a tradução não esconde
 *
 * 1. **Não há prefixo em cache explícito.** O prompt de sistema é reenviado inteiro a
 *    cada volta. O Gemini faz cache implícito e o informa em `cachedContentTokenCount`,
 *    que reportamos como leitura de cache — mas não há como **pedir** o cache, só
 *    recebê-lo. No preço do `flash-lite` isso custa menos que o prefixo em cache do Opus.
 * 2. **Saída estruturada não convive com tools.** O `responseJsonSchema` do Gemini é
 *    mutuamente exclusivo com `functionDeclarations`, e o runner pede as duas coisas em
 *    todo turno. A saída estruturada vira então **instrução no prompt**, e o texto volta
 *    limpo de cerca de markdown — ver `stripFence`. O contrato de saída continua sendo
 *    conferido pelo Zod no runner, que é quem de fato garante a forma.
 * 3. **Não há `thinking` a pedir.** O turno responde direto; o rascunho que o modelo
 *    eventualmente devolve (`thought`) é descartado em `fromGeminiParts`.
 */

/** Preço do `gemini-3.5-flash-lite`, em dólares por milhão de tokens. */
const USD_PER_MTOK = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 } as const

/**
 * O token de **áudio** na entrada custa mais que o de texto: o Google cobra três vezes a
 * tarifa da entrada de texto no `flash-lite`. É o único preço que a transcrição tem de
 * diferente do turno.
 */
const USD_PER_MTOK_AUDIO_INPUT = 0.3

/**
 * O que sai do modelo, raciocínio incluído.
 *
 * `candidatesTokenCount` conta só a resposta; o rascunho do modelo (`thought`) vem em
 * `thoughtsTokenCount` e é cobrado como saída do mesmo jeito. Deixá-lo de fora faria o
 * teto mensal chegar depois da fatura.
 */
function outputTokensOf(meta: GenerateContentResponseUsageMetadata | undefined): number {
  return (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0)
}

/**
 * O que a saída estruturada vira quando não pode ser declarada.
 *
 * Anexado ao fim do prompt de sistema, e não ao começo: o prefixo do prompt é o que o
 * cache implícito do Gemini tem chance de reaproveitar entre turnos, e mexer na frente
 * dele o quebraria do mesmo jeito que quebra o da Anthropic.
 */
const JSON_OUTPUT_INSTRUCTION = [
  '',
  '## Formato da resposta',
  '',
  'Responda SEMPRE com um único objeto JSON, sem cerca de markdown e sem texto fora dele,',
  'exatamente neste formato:',
  '',
  JSON.stringify(AGENT_TURN_OUTPUT_JSON_SCHEMA, null, 2),
  '',
  'O campo `reply` é o que o cliente vai ler no WhatsApp. Quando precisar chamar uma',
  'ferramenta, chame a ferramenta e não responda JSON nenhum neste turno.',
].join('\n')

/**
 * O identificador da chamada: o único lugar onde cabe o que o Gemini exige de volta.
 *
 * O `tool_use_id` da Anthropic é o que casa o resultado com o pedido, e o runner o
 * devolve intacto no `tool_result` — é o único campo nosso que faz a viagem de ida e
 * volta. Do lado do Gemini são **três** coisas que precisam voltar, e nenhuma delas tem
 * campo no bloco da Anthropic:
 *
 * 1. o **nome** da função, que o `functionResponse` exige;
 * 2. o `id` do provedor, que só existe nas chamadas paralelas;
 * 3. a **`thoughtSignature`**, que é o que fazia o segundo round responder 400.
 *
 * A terceira é a que não se adivinha. Os modelos Gemini 3 assinam cada `functionCall` e
 * **recusam o turno seguinte se a assinatura não voltar** — `Function call is missing a
 * thought_signature in functionCall parts`. Ela chega na `Part`, irmã do `functionCall`,
 * e some em qualquer tradução que olhe só para o `functionCall`.
 *
 * Daí o id ser um envelope: prefixo reconhecível mais os três campos em base64url. Isso
 * mantém a tradução **sem estado** — nada de mapa de ids vivo entre conversas — e o id
 * nunca sai do processo: ele morre no fim do turno e não é gravado em lugar nenhum.
 */
const CALL_ID_PREFIX = 'gem_'

export function encodeCallId(
  name: string,
  geminiId: string | undefined,
  signature: string | undefined,
): string {
  const payload = JSON.stringify({ n: name, i: geminiId, s: signature })
  return CALL_ID_PREFIX + Buffer.from(payload, 'utf8').toString('base64url')
}

export function decodeCallId(id: string): {
  name: string
  geminiId?: string
  signature?: string
} {
  if (!id.startsWith(CALL_ID_PREFIX)) return { name: id }

  try {
    const raw = Buffer.from(id.slice(CALL_ID_PREFIX.length), 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as { n?: string; i?: string; s?: string }
    if (typeof parsed.n !== 'string') return { name: id }
    return {
      name: parsed.n,
      ...(parsed.i ? { geminiId: parsed.i } : {}),
      ...(parsed.s ? { signature: parsed.s } : {}),
    }
  } catch {
    // Um id que não é nosso envelope vale como nome puro: é o que o dublê de um teste
    // produziria, e falhar aqui trocaria um turno degradado por um turno perdido.
    return { name: id }
  }
}

/** As tools do módulo, no dialeto do Gemini. `parametersJsonSchema` aceita JSON Schema cru. */
export function toFunctionDeclarations(tools: Anthropic.Tool[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parametersJsonSchema: tool.input_schema,
  }))
}

/** O histórico da Anthropic no dialeto do Gemini, que chama o assistente de `model`. */
export function toGeminiContents(messages: Anthropic.MessageParam[]): Content[] {
  return messages.map((message) => {
    const role = message.role === 'assistant' ? 'model' : 'user'

    if (typeof message.content === 'string') {
      return { role, parts: [{ text: message.content }] }
    }

    const parts: Part[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text })
        continue
      }

      if (block.type === 'tool_use') {
        const { name, geminiId, signature } = decodeCallId(block.id)
        parts.push({
          functionCall: {
            ...(geminiId ? { id: geminiId } : {}),
            name,
            args: (block.input ?? {}) as Record<string, unknown>,
          },
          // Irmã do `functionCall`, e obrigatória no turno seguinte — ver `encodeCallId`.
          ...(signature ? { thoughtSignature: signature } : {}),
        })
        continue
      }

      if (block.type === 'tool_result') {
        const { name, geminiId } = decodeCallId(block.tool_use_id)
        parts.push({
          functionResponse: {
            ...(geminiId ? { id: geminiId } : {}),
            name,
            // A chave `output` é o que o Gemini espera para o retorno útil da função.
            response: { output: toolResultText(block.content) },
          },
        })
        continue
      }

      /**
       * `thinking` e os blocos de tool de servidor não existem aqui, e um bloco que o
       * Gemini não entenda derrubaria o turno inteiro. Ignorar é o certo: o histórico
       * deste módulo só carrega texto, chamada e resultado.
       */
    }

    return { role, parts }
  })
}

/** O corpo de um `tool_result`, que a Anthropic aceita como texto ou como blocos. */
function toolResultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * A cerca de markdown que a instrução pede para não existir, e que aparece assim mesmo.
 *
 * Sem isto o `JSON.parse` do runner falha, o turno vira impasse e a conversa vai para a
 * recepção — um handoff causado por três crases.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed

  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```$/, '')
    .trim()
}

/** As partes do Gemini nos blocos que o runner sabe ler. */
export function fromGeminiParts(parts: Part[]): Anthropic.ContentBlock[] {
  const blocks: Anthropic.ContentBlock[] = []

  for (const part of parts) {
    if (part.functionCall?.name) {
      blocks.push({
        type: 'tool_use',
        id: encodeCallId(part.functionCall.name, part.functionCall.id, part.thoughtSignature),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        caller: { type: 'direct' },
      })
      continue
    }

    /**
     * `thought` marca o rascunho do modelo, que não é resposta. Deixá-lo entrar faria o
     * `parseOutput` juntar raciocínio com JSON e falhar na desserialização.
     */
    if (typeof part.text === 'string' && part.text && !part.thought) {
      blocks.push({ type: 'text', text: part.text, citations: null })
    }
  }

  // A cerca só se tira depois de juntar: ela envolve o texto todo, não cada pedaço.
  const texts = blocks.filter((block): block is Anthropic.TextBlock => block.type === 'text')
  if (texts.length > 0) {
    const joined = stripFence(texts.map((block) => block.text).join(''))
    const first = texts[0]
    if (first) first.text = joined
    for (const extra of texts.slice(1)) extra.text = ''
  }

  return blocks.filter((block) => block.type !== 'text' || block.text !== '')
}

/**
 * A recusa que é da **chave**, e não da chamada.
 *
 * O Gemini responde chave inválida ou expirada com **400** (`API_KEY_INVALID`), e não com
 * 401 — o mesmo status de um pedido malformado. Por isso o 400 só conta quando a mensagem
 * fala da chave: um 400 de esquema de tool tratado como chave recusada faria a tela mandar
 * o petshop trocar uma chave que funciona.
 */
function isKeyRejection(error: ApiError): boolean {
  if (error.status === 401 || error.status === 403) return true
  return error.status === 400 && /api[ _]key/i.test(error.message)
}

/**
 * **Nada disto chega ao tutor como erro** (RN-09). Quem trata é o `runner.ts`, que manda
 * a conversa para a recepção — e, na chave recusada, grava o motivo para a tela.
 */
function translateError(error: unknown): Error {
  if (error instanceof ApiError) {
    if (isKeyRejection(error)) {
      return new ModelKeyRejectedError(`O Google recusou a chave (${error.status})`)
    }
    if (error.status === 429) {
      // A cota do free tier é por minuto e por dia; estourar passa sozinho.
      logger.warn({ detail: error.message }, 'cota do Gemini excedida')
      return providerUnavailable('O provedor do modelo recusou por excesso de chamadas')
    }
    return providerUnavailable(`O provedor do modelo respondeu ${error.status}`)
  }
  return providerUnavailable('O provedor do modelo não respondeu')
}

/**
 * A porta, com a chave de quem paga.
 *
 * A chave chega por parâmetro, e não do ambiente: o mesmo processo fala com o Google em
 * nome de vários petshops, e quem escolhe qual chave usar é `model-port.ts`.
 */
export function createGeminiPort(apiKey: string): ModelPort {
  const env = loadEnv()
  const client = new GoogleGenAI({ apiKey })

  return {
    configured: true,
    rates: ratesFor(USD_PER_MTOK),

    async complete(request: ModelRequest): Promise<ModelResponse> {
      try {
        const response = await client.models.generateContent({
          model: env.GEMINI_MODEL,
          contents: toGeminiContents(request.messages),
          config: {
            systemInstruction: request.structured
              ? `${request.system}\n${JSON_OUTPUT_INSTRUCTION}`
              : request.system,
            maxOutputTokens: 8_000,
            tools: [{ functionDeclarations: toFunctionDeclarations(request.tools) }],
          },
        })

        const parts = response.candidates?.[0]?.content?.parts ?? []
        const content = fromGeminiParts(parts)
        const usedTools = content.some((block) => block.type === 'tool_use')

        const meta = response.usageMetadata
        const cacheReadTokens = meta?.cachedContentTokenCount ?? 0

        return {
          content,
          stopReason: usedTools ? 'tool_use' : 'end_turn',
          usage: {
            /**
             * `promptTokenCount` **inclui** o que veio do cache implícito, e as duas
             * tarifas são diferentes. Somar os dois inteiros cobraria o token em cache
             * duas vezes, e o teto mensal chegaria antes da hora.
             */
            inputTokens: Math.max(0, (meta?.promptTokenCount ?? 0) - cacheReadTokens),
            outputTokens: outputTokensOf(meta),
            cacheReadTokens,
            // Não há escrita de cache a pedido: o Gemini decide sozinho e não a cobra.
            cacheWriteTokens: 0,
          },
        }
      } catch (error) {
        throw translateError(error)
      }
    },
  }
}

/**
 * Confere uma chave antes de gravá-la.
 *
 * Listar modelos é a chamada mais barata que exige autenticação: não gasta token, e a
 * recusa chega com o mesmo status que chegaria no meio de uma conversa. `true` é "serve",
 * `false` é "o Google recusou"; qualquer outra falha (rede, 5xx) sobe, porque não diz
 * nada sobre a chave.
 */
export async function verifyGeminiKey(apiKey: string): Promise<boolean> {
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 10_000 } })
  try {
    await client.models.list({ config: { pageSize: 1 } })
    return true
  } catch (error) {
    if (error instanceof ApiError && isKeyRejection(error)) return false
    throw providerUnavailable('Não foi possível falar com o Google agora')
  }
}

/**
 * O pedido da transcrição.
 *
 * "Devolva vazio" é o que segura a alucinação no silêncio — o vício que o Whisper tinha
 * ("Obrigado por assistir") e que o Gemini também tem quando não ouve fala nenhuma. E
 * nada de lista de vocabulário do petshop: no Whisper ela foi medida e **piorou** o texto
 * ("o Thor amanhã" virou "outor a manhã"), porque o modelo passa a imitar a lista em vez
 * de ouvir.
 */
const TRANSCRIPTION_INSTRUCTION = [
  'Transcreva fielmente a fala deste áudio, em português do Brasil.',
  'Devolva só a transcrição, em texto corrido: sem aspas, sem marcação de quem fala,',
  'sem comentários e sem resumir.',
  'Se não houver fala reconhecível, devolva uma resposta vazia.',
].join(' ')

/**
 * Um minuto: o áudio tem no máximo 120 s (`AGENT_AUDIO_MAX_SECONDS`) e a transcrição sai
 * em poucos segundos. Quem segura a posse da conversa durante a espera é o
 * `holdingClaim` do runner, não este número.
 */
const TRANSCRIPTION_TIMEOUT_MS = 60_000

/** O `audio/ogg; codecs=opus` do WhatsApp: o Gemini quer o tipo sem parâmetro. */
function audioMimeType(mimetype: string): string {
  return mimetype.split(';')[0]?.trim() || 'audio/ogg'
}

/**
 * O ouvido do agente, com a mesma chave do turno.
 *
 * O áudio vai **inline**, e não pela File API: o do WhatsApp tem dezenas de kB, muito
 * abaixo do teto de 20 MB do pedido, e o upload seria uma segunda chamada e um arquivo
 * para apagar depois.
 */
export interface GeminiTranscription {
  text: string
  /** Tokens de áudio na entrada; o resto da entrada é a instrução, em texto. */
  audioTokens: number
  inputTokens: number
  outputTokens: number
  /** Na unidade de `agent_turns.cost_millicents` — é ela que o teto mensal soma. */
  costMillicents: number
}

/** RN-13 também no ouvido: o custo sai do `usageMetadata`, nunca de estimativa. */
export function transcriptionCost(meta: GenerateContentResponseUsageMetadata | undefined): {
  audioTokens: number
  inputTokens: number
  outputTokens: number
  costMillicents: number
} {
  const inputTokens = meta?.promptTokenCount ?? 0
  const audioTokens = Math.min(
    inputTokens,
    (meta?.promptTokensDetails ?? [])
      .filter((detail) => detail.modality === MediaModality.AUDIO)
      .reduce((total, detail) => total + (detail.tokenCount ?? 0), 0),
  )
  const outputTokens = outputTokensOf(meta)

  const rates = ratesFor(USD_PER_MTOK)
  const audioRate = ratesFor({ ...USD_PER_MTOK, input: USD_PER_MTOK_AUDIO_INPUT }).input
  const costMillicents = Math.round(
    audioTokens * audioRate +
      (inputTokens - audioTokens) * rates.input +
      outputTokens * rates.output,
  )
  return { audioTokens, inputTokens, outputTokens, costMillicents }
}

export function createGeminiTranscriber(
  apiKey: string,
): (bytes: Buffer, mimetype: string) => Promise<GeminiTranscription> {
  const env = loadEnv()
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: TRANSCRIPTION_TIMEOUT_MS } })

  return async (bytes, mimetype) => {
    try {
      const response = await client.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: audioMimeType(mimetype), data: bytes.toString('base64') } },
              { text: TRANSCRIPTION_INSTRUCTION },
            ],
          },
        ],
        config: { temperature: 0, maxOutputTokens: 2_000 },
      })
      const parts = response.candidates?.[0]?.content?.parts ?? []
      const text = parts
        .filter((part) => typeof part.text === 'string' && !part.thought)
        .map((part) => part.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      return { text, ...transcriptionCost(response.usageMetadata) }
    } catch (error) {
      throw translateError(error)
    }
  }
}
