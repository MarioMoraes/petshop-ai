import { logger } from './logger.js'

/**
 * Uma chamada à API do Asaas, com a chave e o servidor de quem cobra.
 *
 * Dois módulos falam com o Asaas, com contas diferentes: a assinatura (`subscription`)
 * cobra o petshop com a conta da PetShop AI, lida do ambiente; a cobrança online do tutor
 * (`ledger`) cobra o tutor com a conta do petshop, cadastrada em Integrações. O HTTP é o
 * mesmo — cabeçalho, timeout, o corpo do erro que vai para o log e nunca para a tela —, e
 * mora aqui para não haver dois jeitos de falar com o mesmo provedor.
 *
 * `AsaasHttpError` leva o status: 401 é chave recusada, e quem chama decide o que dizer.
 */

const TIMEOUT_MS = 15_000

export const ASAAS_BASE_URLS = {
  SANDBOX: 'https://api-sandbox.asaas.com/v3',
  PRODUCTION: 'https://api.asaas.com/v3',
} as const

export class AsaasHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail)
    this.name = 'AsaasHttpError'
  }
}

export async function asaasCall<T>(
  credentials: { apiKey: string; baseUrl: string },
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${credentials.baseUrl}${path}`, {
      method,
      headers: {
        access_token: credentials.apiKey,
        'content-type': 'application/json',
        'user-agent': 'petshop-ai',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      // O corpo do erro do Asaas vai para o log, e não para a tela: ele fala de campos da
      // API dele, que quem está pagando não tem como corrigir.
      logger.error({ status: response.status, path, body: text.slice(0, 500) }, 'Asaas recusou')
      throw new AsaasHttpError(response.status, text.slice(0, 500))
    }
    return (text ? JSON.parse(text) : {}) as T
  } catch (error) {
    if (error instanceof AsaasHttpError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      logger.error({ path }, 'Asaas não respondeu a tempo')
      throw new AsaasHttpError(504, 'timeout')
    }
    logger.error({ err: error, path }, 'falha ao falar com o Asaas')
    throw new AsaasHttpError(503, 'rede')
  } finally {
    clearTimeout(timeout)
  }
}
