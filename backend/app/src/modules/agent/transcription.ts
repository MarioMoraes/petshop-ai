import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'

/**
 * O ouvido do agente: o áudio do cliente vira texto pelo Whisper da própria instalação.
 *
 * **O Whisper roda aqui, e não numa API paga.** É o serviço `whisper` da stack
 * (`openai-whisper-asr-webservice`, motor `faster_whisper`), alcançado pela rede interna
 * como o Gotenberg. Duas consequências que valem a escolha: o áudio do cliente não sai
 * do nosso servidor para terceiro nenhum, e o custo não cresce por minuto ouvido — ele
 * é a CPU da máquina, e por isso tem teto de duração e de concorrência.
 *
 * Mesmo desenho de porta do `model-port.ts`: sem `WHISPER_URL` a porta existe e diz que
 * não está configurada, e o áudio segue para a recepção como antes de este arquivo
 * existir. A suíte troca o cliente por um dublê e nunca toca no serviço.
 */

export interface TranscriptionPort {
  configured: boolean
  /** O texto transcrito, já aparado. Vazio é "não havia fala", e quem chama decide. */
  transcribe(bytes: Buffer, mimetype: string): Promise<string>
}

export class TranscriptionError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'TranscriptionError'
  }
}

/**
 * Quatro minutos: o pior caso medido, com folga.
 *
 * O `small` em CPU levou 1,6× a duração do áudio (Docker com 4 CPUs, 2026-10-01): o
 * teto de 120s vira ~3 minutos. Quem segura a posse da conversa durante a espera é o
 * `holdingClaim` do runner, não este número.
 */
const TIMEOUT_MS = 240_000

/**
 * Uma transcrição por processo de cada vez.
 *
 * O serviço serializa atrás de uma trava, então uma segunda requisição só esperaria lá
 * dentro — com o relógio do `TIMEOUT_MS` correndo. Aqui a fila não tem relógio.
 */
const MAX_CONCURRENT = 1

function semaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  return async (task) => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    running += 1
    try {
      return await task()
    } finally {
      running -= 1
      waiting.shift()?.()
    }
  }
}

function extensionOf(mimetype: string): string {
  if (mimetype.includes('ogg')) return 'ogg'
  if (mimetype.includes('mpeg') || mimetype.includes('mp3')) return 'mp3'
  if (mimetype.includes('mp4') || mimetype.includes('m4a') || mimetype.includes('aac')) {
    return 'm4a'
  }
  if (mimetype.includes('wav')) return 'wav'
  return 'bin'
}

function createWhisperPort(baseUrl: string): TranscriptionPort {
  const limited = semaphore(MAX_CONCURRENT)

  return {
    configured: true,
    transcribe(bytes, mimetype) {
      return limited(async () => {
        const params = new URLSearchParams({
          task: 'transcribe',
          language: 'pt',
          output: 'txt',
          // O silêncio no fim do áudio é onde o Whisper "alucina" frases de legenda
          // ("Obrigado por assistir"). O VAD corta antes de o modelo ouvir.
          //
          // Sem `initial_prompt` de propósito: uma lista de vocabulário do petshop foi
          // medida e **piorou** o texto — "o Thor amanhã" virou "outor a manhã". O
          // modelo passa a imitar a lista em vez de ouvir.
          vad_filter: 'true',
        })
        const form = new FormData()
        const type = mimetype.split(';')[0]?.trim() || 'application/octet-stream'
        form.append(
          'audio_file',
          new Blob([new Uint8Array(bytes)], { type }),
          `audio.${extensionOf(mimetype)}`,
        )

        let response: Response
        try {
          response = await fetch(`${baseUrl}/asr?${params.toString()}`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch (error) {
          throw new TranscriptionError(
            error instanceof Error ? `Whisper inalcançável: ${error.message}` : 'Whisper inalcançável',
          )
        }
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 200)
          throw new TranscriptionError(`Whisper respondeu ${response.status}: ${detail}`)
        }
        return (await response.text()).replace(/\s+/g, ' ').trim()
      })
    },
  }
}

const unconfigured: TranscriptionPort = {
  configured: false,
  async transcribe() {
    throw new TranscriptionError('A transcrição de áudio não está configurada')
  },
}

let port: TranscriptionPort | null = null

export function getTranscriptionPort(): TranscriptionPort {
  if (port) return port
  const url = loadEnv().WHISPER_URL?.trim()
  if (!url) {
    logger.info('WHISPER_URL ausente — áudio recebido vai para a recepção')
    port = unconfigured
    return port
  }
  port = createWhisperPort(url.replace(/\/+$/, ''))
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTranscriptionPort(next: TranscriptionPort | null): void {
  port = next
}
