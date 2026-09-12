import type Anthropic from '@anthropic-ai/sdk'
import type { Part } from '@google/genai'
import { describe, expect, it } from 'vitest'
import {
  decodeCallId,
  encodeCallId,
  fromGeminiParts,
  stripFence,
  toFunctionDeclarations,
  toGeminiContents,
} from '../../src/modules/agent/model-gemini.js'

/**
 * A tradução do provedor alternativo (`AI_PROVIDER=gemini`).
 *
 * **O que estes testes protegem é o encaixe, não o modelo.** O vocabulário da porta é o
 * da Anthropic, e o cliente do Gemini traduz nas duas pontas; um erro de tradução não
 * aparece como exceção, aparece como o agente parando de chamar tools ou respondendo JSON
 * cru ao cliente no WhatsApp.
 *
 * São funções puras de propósito: exercitá-las não gasta cota nem exige chave. O que fica
 * de fora é só o HTTP, como no dublê do provedor de produção.
 */

const toolUse = (id: string, name: string, input: unknown): Anthropic.ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
})

describe('identificador da chamada', () => {
  it('carrega nome, id do provedor e assinatura de volta', () => {
    const id = encodeCallId('listarMeusPets', 'call-42', 'assinatura-abc')
    expect(decodeCallId(id)).toEqual({
      name: 'listarMeusPets',
      geminiId: 'call-42',
      signature: 'assinatura-abc',
    })
  })

  it('omite o que o provedor não mandou', () => {
    const id = encodeCallId('consultarDisponibilidade', undefined, undefined)
    expect(decodeCallId(id)).toEqual({ name: 'consultarDisponibilidade' })
  })

  it('sobrevive a nome e assinatura com os caracteres do base64', () => {
    const sig = 'Cq4BAdHtim/+abc=='
    expect(decodeCallId(encodeCallId('proporAgendamento', 'c/1+2', sig))).toEqual({
      name: 'proporAgendamento',
      geminiId: 'c/1+2',
      signature: sig,
    })
  })

  it('trata um id que não veio deste codificador como nome puro', () => {
    expect(decodeCallId('toolu_01abc')).toEqual({ name: 'toolu_01abc' })
  })
})

describe('histórico da Anthropic para o Gemini', () => {
  it('renomeia o papel do assistente para model', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá!' },
    ])

    expect(contents.map((c) => c.role)).toEqual(['user', 'model'])
    expect(contents[0]?.parts).toEqual([{ text: 'oi' }])
  })

  it('leva a chamada e o resultado de volta casados pelo nome', () => {
    const id = encodeCallId('listarMeusPets', 'call-7', 'sig-1')
    const contents = toGeminiContents([
      { role: 'user', content: 'quais são meus pets?' },
      { role: 'assistant', content: [toolUse(id, 'listarMeusPets', { limite: 5 })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Rex, Mia' }] },
    ])

    expect(contents[1]?.parts?.[0]).toEqual({
      functionCall: { id: 'call-7', name: 'listarMeusPets', args: { limite: 5 } },
      // Sem ela o Gemini 3 responde 400 no turno seguinte — ver `encodeCallId`.
      thoughtSignature: 'sig-1',
    })
    expect(contents[2]?.parts?.[0]?.functionResponse).toEqual({
      id: 'call-7',
      name: 'listarMeusPets',
      response: { output: 'Rex, Mia' },
    })
  })

  it('achata o resultado que veio em blocos, e não só em texto', () => {
    const id = encodeCallId('situacaoFinanceira', undefined, undefined)
    const contents = toGeminiContents([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: [
              { type: 'text', text: 'linha 1' },
              { type: 'text', text: 'linha 2' },
            ],
          },
        ],
      },
    ])

    expect(contents[0]?.parts?.[0]?.functionResponse?.response).toEqual({
      output: 'linha 1\nlinha 2',
    })
  })

  /**
   * Um bloco que o Gemini não entenda derruba o turno inteiro. O histórico deste módulo
   * só carrega texto, chamada e resultado — o resto se ignora em silêncio.
   */
  it('descarta bloco que não é texto, chamada nem resultado', () => {
    const contents = toGeminiContents([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'rascunho', signature: 'sig' },
          { type: 'text', text: 'resposta' },
        ],
      },
    ])

    expect(contents[0]?.parts).toEqual([{ text: 'resposta' }])
  })
})

describe('tools no dialeto do Gemini', () => {
  it('passa o JSON Schema cru, sem traduzir', () => {
    const schema = {
      type: 'object' as const,
      properties: { petId: { type: 'string' } },
      required: ['petId'],
    }
    const [declaration] = toFunctionDeclarations([
      { name: 'statusDoTaxi', description: 'o que é', input_schema: schema },
    ])

    expect(declaration).toEqual({
      name: 'statusDoTaxi',
      description: 'o que é',
      parametersJsonSchema: schema,
    })
  })
})

describe('resposta do Gemini para os blocos do runner', () => {
  it('vira tool_use com o marcador de chamada direta que o tipo exige', () => {
    const parts: Part[] = [
      { functionCall: { id: 'c1', name: 'listarServicos', args: {} }, thoughtSignature: 'sig' },
    ]
    const [block] = fromGeminiParts(parts)

    expect(block).toMatchObject({ type: 'tool_use', name: 'listarServicos', input: {} })
    expect(decodeCallId((block as Anthropic.ToolUseBlock).id)).toEqual({
      name: 'listarServicos',
      geminiId: 'c1',
      signature: 'sig',
    })
  })

  /**
   * A ida e volta completa: é ela que o provedor recusava com 400 antes de a assinatura
   * ser carregada, e o 400 só aparecia no **segundo** round de tools.
   */
  it('devolve a assinatura ao provedor na volta do resultado', () => {
    const blocks = fromGeminiParts([
      { functionCall: { id: 'c9', name: 'listarServicos', args: {} }, thoughtSignature: 'zzz' },
    ])
    const contents = toGeminiContents([{ role: 'assistant', content: blocks }])

    expect(contents[0]?.parts?.[0]).toMatchObject({ thoughtSignature: 'zzz' })
  })

  it('dá ids distintos a duas chamadas da mesma tool com assinaturas diferentes', () => {
    const parts: Part[] = [
      {
        functionCall: { name: 'consultarDisponibilidade', args: { dia: '1' } },
        thoughtSignature: 'a',
      },
      {
        functionCall: { name: 'consultarDisponibilidade', args: { dia: '2' } },
        thoughtSignature: 'b',
      },
    ]
    const blocks = fromGeminiParts(parts) as Anthropic.ToolUseBlock[]

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.id).not.toEqual(blocks[1]?.id)
  })

  /** Três crases bastariam para o `JSON.parse` do runner falhar e a conversa virar handoff. */
  it('tira a cerca de markdown do JSON da resposta', () => {
    const parts: Part[] = [
      { text: '```json\n{"reply":"oi","sentiment":"NEUTRAL","handoff":false}\n```' },
    ]
    const [block] = fromGeminiParts(parts)

    expect(JSON.parse((block as Anthropic.TextBlock).text)).toEqual({
      reply: 'oi',
      sentiment: 'NEUTRAL',
      handoff: false,
    })
  })

  it('junta o texto partido antes de tirar a cerca', () => {
    const parts: Part[] = [{ text: '```json\n{"reply":' }, { text: '"oi"}\n```' }]
    const blocks = fromGeminiParts(parts)

    expect(blocks).toHaveLength(1)
    expect((blocks[0] as Anthropic.TextBlock).text).toBe('{"reply":"oi"}')
  })

  /** O rascunho não é resposta: juntá-lo ao JSON quebraria a desserialização. */
  it('ignora a parte marcada como pensamento', () => {
    const parts: Part[] = [{ text: 'deixa eu ver', thought: true }, { text: '{"reply":"oi"}' }]
    const blocks = fromGeminiParts(parts)

    expect(blocks).toHaveLength(1)
    expect((blocks[0] as Anthropic.TextBlock).text).toBe('{"reply":"oi"}')
  })

  it('devolve lista vazia quando o candidato não trouxe parte nenhuma', () => {
    expect(fromGeminiParts([])).toEqual([])
  })
})

describe('cerca de markdown', () => {
  it('deixa intacto o texto que já vem limpo', () => {
    expect(stripFence('{"reply":"oi"}')).toBe('{"reply":"oi"}')
  })

  it('tira a cerca sem rótulo de linguagem', () => {
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
})
