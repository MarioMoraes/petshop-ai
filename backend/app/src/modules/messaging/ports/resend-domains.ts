import { loadEnv } from '../../../config/env.js'
import { logger } from '../../../shared/logger.js'

/**
 * A API de Domains do Resend — o domínio de e-mail próprio do estabelecimento.
 *
 * O domínio é registrado na conta **da plataforma**, com a mesma `RESEND_API_KEY` que
 * envia: o petshop não abre conta no Resend, só publica os registros de DNS. É por isso
 * que a chave precisa ser de *acesso total* — uma chave de *só envio* recebe 401 aqui, e
 * a tela diz que o recurso está indisponível em vez de fingir que cadastrou.
 *
 * Chamada por `fetch`, e não pelo SDK, pela mesma razão do `email.ts`: são quatro
 * rotas, e o vocabulário do Resend (`not_started`, `temporary_failure`) morre aqui.
 */

const API = 'https://api.resend.com/domains'
const TIMEOUT_MS = 10_000

/** Um registro de DNS que o petshop precisa publicar. */
export interface DomainRecord {
  /** O papel dele: SPF, DKIM, MX de retorno. Só informativo. */
  record: string
  type: string
  name: string
  value: string
  priority: number | null
  /** Se o Resend já o enxerga publicado. */
  verified: boolean
}

export type ProviderDomainStatus = 'PENDING' | 'VERIFIED' | 'FAILED'

export interface ProviderDomain {
  id: string
  status: ProviderDomainStatus
  records: DomainRecord[]
}

export interface ResendDomainsPort {
  configured(): boolean
  create(domain: string): Promise<ProviderDomain>
  get(id: string): Promise<ProviderDomain>
  /** Pede ao Resend que confira o DNS agora. O resultado chega depois, pelo `get`. */
  verify(id: string): Promise<void>
  remove(id: string): Promise<void>
}

/** A falha do provedor, com o status — o 422 de domínio já cadastrado é tratado à parte. */
export class ResendDomainsError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail)
    this.name = 'ResendDomainsError'
  }
}

interface RawRecord {
  record?: string
  type?: string
  name?: string
  value?: string
  priority?: number
  status?: string
}

interface RawDomain {
  id: string
  status?: string
  records?: RawRecord[]
}

/**
 * `not_started` e `pending` são o mesmo estado para quem publica o DNS: ainda não deu.
 * `temporary_failure` também — o Resend volta a tentar sozinho. Só `failed` é definitivo,
 * e mesmo ele se desfaz com um novo `verify` depois de corrigir o registro.
 */
function statusOf(raw: string | undefined): ProviderDomainStatus {
  if (raw === 'verified') return 'VERIFIED'
  if (raw === 'failed') return 'FAILED'
  return 'PENDING'
}

function toDomain(raw: RawDomain): ProviderDomain {
  return {
    id: raw.id,
    status: statusOf(raw.status),
    records: (raw.records ?? []).map((record) => ({
      record: record.record ?? '',
      type: record.type ?? '',
      name: record.name ?? '',
      value: record.value ?? '',
      priority: typeof record.priority === 'number' ? record.priority : null,
      verified: record.status === 'verified',
    })),
  }
}

function createResendDomainsPort(): ResendDomainsPort {
  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const apiKey = loadEnv().RESEND_API_KEY
    if (!apiKey) throw new ResendDomainsError(503, 'RESEND_API_KEY ausente')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        logger.error(
          { status: response.status, path, body: text.slice(0, 400) },
          'Resend Domains recusou',
        )
        throw new ResendDomainsError(response.status, text.slice(0, 400))
      }
      return (text ? JSON.parse(text) : {}) as T
    } catch (error) {
      if (error instanceof ResendDomainsError) throw error
      logger.error({ err: error, path }, 'falha ao falar com o Resend Domains')
      throw new ResendDomainsError(503, 'O Resend não respondeu')
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    configured: () => Boolean(loadEnv().RESEND_API_KEY),
    async create(domain) {
      return toDomain(await call<RawDomain>('POST', '', { name: domain }))
    },
    async get(id) {
      return toDomain(await call<RawDomain>('GET', `/${id}`))
    },
    async verify(id) {
      await call('POST', `/${id}/verify`)
    },
    async remove(id) {
      await call('DELETE', `/${id}`)
    },
  }
}

let port: ResendDomainsPort | null = null

export function getResendDomainsPort(): ResendDomainsPort {
  port ??= createResendDomainsPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setResendDomainsPort(next: ResendDomainsPort | null): void {
  port = next
}
