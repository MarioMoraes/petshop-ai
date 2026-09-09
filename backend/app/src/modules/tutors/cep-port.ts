import { CepLookupSchema, formatCEP, onlyDigits, type CepLookup } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { cepUnavailable } from './errors.js'
import { logger } from '../../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../../shared/redis.js'

/**
 * Consulta de CEP (MOD-TUTOR-03, questão 2 do PRD §11 — decidido: ViaCEP).
 *
 * Atrás de uma porta injetável, como o Clerk no MOD-IDENT: é o que permite a
 * suíte rodar sem rede e sem depender da disponibilidade de um serviço de terceiro.
 *
 * A resposta é cacheada por 24h: CEP praticamente não muda, e o ViaCEP não tem SLA.
 * Indisponibilidade vira ERR_TUTOR_008 e a UI segue com preenchimento manual — o
 * cadastro do tutor jamais fica bloqueado por causa de um serviço externo.
 */

export interface CepPort {
  lookup(zipCode: string): Promise<CepLookup | null>
}

/** Resposta do ViaCEP. `erro` vem como `"true"` (string) quando o CEP não existe. */
interface ViaCepResponse {
  cep?: string
  logradouro?: string
  bairro?: string
  localidade?: string
  uf?: string
  erro?: boolean | string
}

const viaCepPort: CepPort = {
  async lookup(zipCode) {
    const env = loadEnv()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), env.CEP_LOOKUP_TIMEOUT_MS)

    try {
      const response = await fetch(`${env.VIACEP_BASE_URL}/${zipCode}/json/`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`ViaCEP respondeu ${response.status}`)

      const payload = (await response.json()) as ViaCepResponse
      // CEP inexistente não é falha do serviço: é resposta 200 com `erro: true`.
      if (payload.erro === true || payload.erro === 'true') return null

      return {
        zipCode: onlyDigits(payload.cep ?? zipCode),
        street: payload.logradouro ?? '',
        district: payload.bairro ?? '',
        city: payload.localidade ?? '',
        state: (payload.uf ?? '').toUpperCase(),
      }
    } finally {
      clearTimeout(timeout)
    }
  },
}

let port: CepPort = viaCepPort

/** Substitui o provedor. Usado pelos testes e pelo modo offline. */
export function setCepPort(next: CepPort): void {
  port = next
}

export function resetCepPort(): void {
  port = viaCepPort
}

/**
 * Devolve o endereço do CEP, ou `null` quando o CEP não existe.
 * Estoura `ERR_TUTOR_008` apenas quando o **provedor** falhou (AC do §5).
 */
export async function lookupCep(rawZipCode: string): Promise<CepLookup | null> {
  const zipCode = onlyDigits(rawZipCode)
  if (zipCode.length !== 8) return null

  if (loadEnv().DISABLE_CEP_LOOKUP) {
    throw cepUnavailable('Consulta de CEP desabilitada nesta instalação.')
  }

  const cached = await cacheGet<CepLookup | { notFound: true }>(CACHE_KEYS.cep(zipCode))
  if (cached) return 'notFound' in cached ? null : cached

  let result: CepLookup | null
  try {
    result = await port.lookup(zipCode)
  } catch (error) {
    logger.warn({ err: error, zipCode: formatCEP(zipCode) }, 'falha ao consultar o CEP')
    throw cepUnavailable()
  }

  // O "não existe" também é cacheado: sem isso, um CEP digitado errado bate no
  // ViaCEP a cada tecla do formulário.
  const parsed = result ? CepLookupSchema.safeParse(result) : null
  const toCache = parsed?.success ? parsed.data : { notFound: true as const }
  await cacheSet(CACHE_KEYS.cep(zipCode), toCache, CACHE_TTL_SECONDS.cep)

  return parsed?.success ? parsed.data : null
}
