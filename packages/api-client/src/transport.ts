import { type ProblemDetails } from '@petshop/shared-types'
import { type ZodType } from 'zod'

export class ApiError extends Error {
  readonly status: number
  readonly problem: ProblemDetails | null

  constructor(status: number, problem: ProblemDetails | null, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }

  /** Mensagem por campo, no formato que os formulários consomem. */
  get fieldErrors(): Record<string, string> {
    const entries = this.problem?.errors?.map((error) => [error.field, error.message] as const)
    return Object.fromEntries(entries ?? [])
  }

  get code(): string | null {
    return this.problem?.code ?? null
  }
}

export interface ApiClientOptions {
  baseUrl: string
  /** Token de sessão do Clerk. Resolvido por requisição, nunca guardado. */
  getToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
  /** Teto por requisição. Ver `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Teto do envio de arquivo. Ver `UPLOAD_TIMEOUT_MS`. */
  uploadTimeoutMs?: number
}

/**
 * Teto de uma chamada ao gateway, incluindo o tempo de emitir o token no Clerk.
 *
 * **Existe por causa do modo de falha, não da lentidão.** Este cliente roda dentro de
 * Server Components: um `await` que nunca volta deixa o RSC pendurado, e o que o
 * usuário vê é uma **página em branco, sem erro nenhum** — nem overlay do Next, nem
 * linha no terminal. Fica assim para sempre, e não há o que investigar depois.
 *
 * Trinta segundos é folgado de propósito: o SLO mais frouxo do PRD §10 é de 2s no p95,
 * então nada saudável chega perto. O número não é para cortar requisição lenta — é
 * para garantir que toda espera termine em erro visível.
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * Teto do envio de arquivo — quatro vezes o das demais chamadas.
 *
 * Aqui o que atravessa a rede são bytes de imagem, não um JSON de resposta: numa
 * conexão de celular ruim, um envio que vai dar certo passa dos 30s sem nenhum
 * problema, e cortá-lo seria recusar trabalho válido. Dois minutos é largo o bastante
 * para isso e curto o bastante para não ser "nunca".
 */
export const UPLOAD_TIMEOUT_MS = 120_000

interface RequestOptions<T> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  schema?: ZodType<T>
}

/** Um documento binário já lido, pronto para ser repassado pela rota do Next. */
export interface DownloadedFile {
  bytes: Uint8Array
  contentType: string
  filename: string
}

/**
 * As três maneiras de falar com o gateway — JSON, envio de arquivo e download —, com o
 * teto, o token e a leitura do `problem+json` que todo endpoint compartilha. Os arquivos
 * de domínio recebem isto pronto e só descrevem caminho e schema.
 */
export function createTransport(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS

  async function request<T>({ method, path, body, schema }: RequestOptions<T>): Promise<T> {
    // O relógio começa antes do `getToken` porque ele também é rede: emitir o token do
    // template no Clerk é uma ida à internet, e pendurar ali é tão invisível quanto
    // pendurar no gateway.
    const controller = new AbortController()
    const alarme = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await send()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          504,
          null,
          'O servidor demorou demais para responder. Tente novamente em instantes.',
        )
      }
      throw error
    } finally {
      clearTimeout(alarme)
    }

    async function send(): Promise<T> {
      const token = await options.getToken()
      if (controller.signal.aborted) throw new Error('abortado')

      const response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          // Sem corpo, sem `content-type`. O Fastify 5 do gateway rejeita
          // `application/json` com corpo vazio (`FST_ERR_CTP_EMPTY_JSON_BODY`) — e todo
          // DELETE sem payload (excluir foto, excluir pet, desvincular tutor…) mandava
          // esse header à toa e caía no 500 genérico antes de chegar na rota.
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
      })

      if (!response.ok) {
        const problem = await readProblem(response)
        throw new ApiError(
          response.status,
          problem,
          problem?.detail ?? `Falha na requisição (${response.status})`,
        )
      }

      if (response.status === 204) return undefined as T
      const payload = (await response.json()) as unknown
      if (!schema) return payload as T

      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        throw new ApiError(
          response.status,
          null,
          `Resposta fora do contrato em ${path}: ${parsed.error.issues[0]?.message ?? 'formato inesperado'}`,
        )
      }
      return parsed.data
    }
  }

  /**
   * Envio de arquivo. Não passa pelo `request` porque o `content-type` aqui é do
   * `FormData` — com o `boundary` que só ele conhece. Fixar `application/json`, como
   * o `request` faz, quebraria o multipart no primeiro byte.
   *
   * Teto próprio, e mais largo, pela mesma razão: o que sobe aqui é foto de pet, e
   * subir bytes por uma conexão ruim leva legitimamente muito mais tempo que responder
   * um JSON. Cortar em 30s recusaria envio que ia dar certo. Mas ficar **sem** teto
   * repete o modo de falha que `REQUEST_TIMEOUT_MS` existe para tirar do sistema — um
   * envio pendurado nunca volta, e a tela fica girando sem erro nenhum.
   */
  async function upload<T>(path: string, form: FormData, schema?: ZodType<T>): Promise<T> {
    const controller = new AbortController()
    const alarme = setTimeout(() => controller.abort(), uploadTimeoutMs)

    try {
      return await enviar()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          504,
          null,
          'O envio demorou demais. Verifique sua conexão e tente de novo.',
        )
      }
      throw error
    } finally {
      clearTimeout(alarme)
    }

    async function enviar(): Promise<T> {
      const token = await options.getToken()
      if (controller.signal.aborted) throw new Error('abortado')

      const response = await doFetch(`${options.baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: form,
        cache: 'no-store',
      })

      if (!response.ok) {
        const problem = await readProblem(response)
        throw new ApiError(
          response.status,
          problem,
          problem?.detail ?? `Falha no envio (${response.status})`,
        )
      }

      const payload = (await response.json()) as unknown
      if (!schema) return payload as T

      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        throw new ApiError(
          response.status,
          null,
          `Resposta fora do contrato em ${path}: ${parsed.error.issues[0]?.message ?? 'formato inesperado'}`,
        )
      }
      return parsed.data
    }
  }

  /**
   * Baixa um documento binário — hoje, os relatórios em PDF do menu Cobrança.
   *
   * Não passa pelo `request` porque ele termina em `response.json()`: o corpo aqui são
   * bytes de PDF, e tentar parseá-los como JSON quebraria antes de qualquer schema. O
   * caminho de erro, esse sim, continua sendo o mesmo — o gateway responde
   * `application/problem+json` também quando a rota pedida devolveria PDF, e é dele que
   * sai a mensagem que a tela mostra.
   *
   * Devolve `Uint8Array`, e não `Blob`: quem chama é um route handler do Next, no
   * servidor, que vai repassar os bytes adiante. O nome do arquivo vem do
   * `content-disposition` do serviço, que é quem sabe o período impresso.
   */
  async function download(path: string, fallbackFilename: string): Promise<DownloadedFile> {
    const controller = new AbortController()
    const alarme = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const token = await options.getToken()
      if (controller.signal.aborted) throw new Error('abortado')

      const response = await doFetch(`${options.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
        cache: 'no-store',
      })

      if (!response.ok) {
        const problem = await readProblem(response)
        throw new ApiError(
          response.status,
          problem,
          problem?.detail ?? `Falha ao gerar o documento (${response.status})`,
        )
      }

      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        filename: filenameFrom(response.headers.get('content-disposition')) ?? fallbackFilename,
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          504,
          null,
          'O documento demorou demais para ser gerado. Tente novamente em instantes.',
        )
      }
      throw error
    } finally {
      clearTimeout(alarme)
    }
  }

  return { request, upload, download }
}

export type Transport = ReturnType<typeof createTransport>

/** Monta a query string ignorando o que não foi preenchido. */
export function toQueryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  try {
    const payload = (await response.json()) as ProblemDetails
    return typeof payload?.code === 'string' ? payload : null
  } catch {
    return null
  }
}

/**
 * O nome do arquivo, tirado do `content-disposition`.
 *
 * Quem escolhe o nome é o serviço, porque é ele que sabe o que foi impresso — a data-base
 * do relatório de contas a receber, o período do relatório diário. O cliente só repassa;
 * inventar o nome aqui daria dois lugares para mantê-lo em acordo.
 *
 * `filename*` (RFC 5987) vem antes porque, quando existe, é o codificado — e é o que os
 * navegadores preferem.
 */
function filenameFrom(header: string | null): string | null {
  if (!header) return null

  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // Header malformado não vale uma exceção: cai no nome padrão de quem chamou.
    }
  }

  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim() ?? null
}
