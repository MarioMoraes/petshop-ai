import { createGeminiTranscriber } from './model-gemini.js'
import { ModelKeyRejectedError } from './model-contract.js'
import { resolveModelKey } from './model-port.js'

/**
 * O ouvido do agente: o áudio do cliente vira texto pelo Gemini, com a chave do petshop.
 *
 * Até 2026-10-02 era o Whisper da própria stack, numa CPU que serializava os áudios de
 * todos os estabelecimentos. Agora é o mesmo provedor e a mesma chave do turno: quem tem
 * o agente respondendo tem o agente ouvindo, sem serviço a mais na instalação, e o custo
 * do minuto ouvido cai na conta de quem o ouviu.
 *
 * Mesmo desenho de porta do `model-port.ts`: sem chave a porta existe e diz que não está
 * configurada, e o áudio segue para a recepção. A suíte troca o cliente por um dublê e
 * nunca toca no provedor.
 */

export interface Transcription {
  /** O texto transcrito, já aparado. Vazio é "não havia fala", e quem chama decide. */
  text: string
  inputTokens: number
  outputTokens: number
  /**
   * O que a transcrição custou, na unidade de `agent_turns.cost_millicents`. Entra no
   * teto mensal e no da conversa como qualquer turno: é a mesma chave pagando.
   */
  costMillicents: number
}

export interface TranscriptionPort {
  configured: boolean
  transcribe(bytes: Buffer, mimetype: string): Promise<Transcription>
}

export class TranscriptionError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'TranscriptionError'
  }
}

const unconfigured: TranscriptionPort = {
  configured: false,
  async transcribe() {
    throw new TranscriptionError('A transcrição de áudio não está configurada')
  },
}

/** O dublê dos testes: quando presente, responde por todos os tenants. */
let override: TranscriptionPort | null = null

/** Um cliente por chave, pela mesma impressão digital da porta do modelo. */
const byKey = new Map<string, TranscriptionPort>()
const MAX_CACHED_CLIENTS = 500

export async function getTranscriptionPort(tenantId: string): Promise<TranscriptionPort> {
  if (override) return override

  const key = await resolveModelKey(tenantId)
  if (!key) return unconfigured

  let port = byKey.get(key.fingerprint)
  if (!port) {
    if (byKey.size >= MAX_CACHED_CLIENTS) byKey.clear()
    const transcribe = createGeminiTranscriber(key.apiKey)
    port = {
      configured: true,
      async transcribe(bytes, mimetype) {
        try {
          return await transcribe(bytes, mimetype)
        } catch (error) {
          // A chave recusada sobe como está: o runner a grava para a tela dizer por quê.
          if (error instanceof ModelKeyRejectedError) throw error
          throw new TranscriptionError(error instanceof Error ? error.message : String(error))
        }
      },
    }
    byKey.set(key.fingerprint, port)
  }
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTranscriptionPort(next: TranscriptionPort | null): void {
  override = next
  byKey.clear()
}
