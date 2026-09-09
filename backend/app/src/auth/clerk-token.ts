import { createPublicKey } from 'node:crypto'
import { verifyToken } from '@clerk/backend'
import { listFromEnv, loadEnv } from '../config/env.js'
import { logger } from '../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../shared/redis.js'

/**
 * Verificação do JWT de sessão do Clerk.
 *
 * O JWKS é buscado uma vez e guardado no Redis (`clerk:jwks`, TTL 3600s, PRD §10),
 * de onde todas as réplicas do gateway o reaproveitam. Com a chave pública em mãos a
 * verificação é local — sem ida à rede por requisição.
 *
 * Se o JWKS não estiver disponível, cai para a verificação pela `secretKey`, que
 * resolve a chave por conta própria. Mais lenta, mas mantém o gateway de pé quando o
 * cache está frio ou o Redis fora.
 */

export interface SessionClaims {
  /** `sub` — id do usuário no Clerk. */
  clerkUserId: string
  /** `org_id` — Organization ativa, que é o tenant (SPEC §3.3). */
  clerkOrgId: string | null
  /**
   * `permVersion` — publicado pelo JWT template a partir do metadata do membership
   * (ver `docs/setup-clerk.md`). Ausente significa template não configurado; nesse
   * caso a detecção de papel desatualizado fica só por conta da invalidação do
   * cache na troca de papel, que já basta — ver `resolvePermissions` em session.ts.
   */
  permVersion: number | null
  /**
   * `mfa` — publicado pelo JWT template a partir de `user.two_factor_enabled`
   * (ver `docs/setup-clerk.md`). MOD-SEC-01.
   *
   * **`null` significa "não sei", e não "não tem".** Um template que ainda não declara
   * o claim produz token válido sem ele, e tratar isso como ausência de segundo fator
   * transformaria um deploy com template desatualizado em indisponibilidade total do
   * Admin — sem nada no corpo da resposta que explicasse por quê. A exigência do
   * MOD-SEC-02 só é aplicada sobre um `false` explícito; o `null` sai no log e na
   * métrica `mfa_claim_missing`.
   */
  mfaEnabled: boolean | null
  expiresAt: number | null
}

interface Jwk {
  kid: string
  kty: string
  [key: string]: unknown
}

interface JwkSet {
  keys: Jwk[]
}

export class InvalidTokenError extends Error {}

async function fetchJwks(): Promise<JwkSet | null> {
  const cached = await cacheGet<JwkSet>(CACHE_KEYS.jwks)
  if (cached) return cached

  try {
    const response = await fetch('https://api.clerk.com/v1/jwks', {
      headers: { Authorization: `Bearer ${loadEnv().CLERK_SECRET_KEY}` },
    })
    if (!response.ok) {
      logger.warn({ status: response.status }, 'não foi possível buscar o JWKS do Clerk')
      return null
    }
    const jwks = (await response.json()) as JwkSet
    await cacheSet(CACHE_KEYS.jwks, jwks, CACHE_TTL_SECONDS.jwks)
    return jwks
  } catch (error) {
    logger.warn({ err: error }, 'falha ao buscar o JWKS do Clerk')
    return null
  }
}

/** Converte a JWK em PEM SPKI, formato que o `verifyToken` aceita como `jwtKey`. */
export function jwkToPem(jwk: Jwk): string {
  return createPublicKey({ key: jwk as never, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' })
    .toString()
}

/** Lê o `kid` do header do JWT, sem verificar a assinatura. */
export function readKid(token: string): string | null {
  const [header] = token.split('.')
  if (!header) return null
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      kid?: string
    }
    return decoded.kid ?? null
  } catch {
    return null
  }
}

export type TokenVerifier = (
  token: string,
  extraAuthorizedParty?: string,
) => Promise<SessionClaims>

let verifier: TokenVerifier | null = null

/** Injeta um verificador. Usado pelos testes; nunca em produção. */
export function setTokenVerifier(next: TokenVerifier | null): void {
  verifier = next
}

/**
 * `extraAuthorizedParty` é o host do Portal, e existe porque o `authorizedParties` do
 * `@clerk/backend` decide por `includes(azp)` — **comparação de string, sem glob**.
 *
 * O Admin emite token em um host só, que cabe numa lista de ambiente. O Portal emite em
 * `{slug}.{APP_DOMAIN}`, um host por tenant, criado a qualquer hora: nenhuma lista
 * estática o cobre, e um curinga no `.env` nunca casa — foi assim que o Admin quase
 * subiu em produção respondendo 401 a tudo. O que cobre é derivar o host **exato** do
 * slug que veio na requisição, que é mais estreito que um curinga, não mais largo.
 */
export function verifySessionToken(
  token: string,
  extraAuthorizedParty?: string,
): Promise<SessionClaims> {
  return (verifier ?? verifyWithClerk)(token, extraAuthorizedParty)
}

async function verifyWithClerk(
  token: string,
  extraAuthorizedParty?: string,
): Promise<SessionClaims> {
  const env = loadEnv()
  const authorizedParties = listFromEnv(env.CLERK_AUTHORIZED_PARTIES)
  if (extraAuthorizedParty && !authorizedParties.includes(extraAuthorizedParty)) {
    authorizedParties.push(extraAuthorizedParty)
  }

  const options: Record<string, unknown> = {}
  if (authorizedParties.length > 0) options.authorizedParties = authorizedParties

  const kid = readKid(token)
  const jwks = kid ? await fetchJwks() : null
  const jwk = jwks?.keys.find((key) => key.kid === kid)

  let payload: Record<string, unknown>
  try {
    if (jwk) {
      payload = (await verifyToken(token, {
        ...options,
        jwtKey: jwkToPem(jwk),
      })) as unknown as Record<string, unknown>
    } else {
      payload = (await verifyToken(token, {
        ...options,
        secretKey: env.CLERK_SECRET_KEY,
      })) as unknown as Record<string, unknown>
    }
  } catch (error) {
    throw new InvalidTokenError(error instanceof Error ? error.message : 'Token inválido')
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : null
  if (!sub) throw new InvalidTokenError('Token sem o claim `sub`')

  return {
    clerkUserId: sub,
    clerkOrgId: typeof payload.org_id === 'string' ? payload.org_id : null,
    permVersion: readPermVersion(payload),
    mfaEnabled: readMfa(payload),
    expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
  }
}

/**
 * Lê o claim de segundo fator, aceitando as duas formas que um template do Clerk
 * produz: booleano de verdade, quando o valor vem de `{{user.two_factor_enabled}}`, e
 * string, quando alguém o escreve entre aspas no editor de template. Qualquer outra
 * coisa é `null` — inclusive o claim ausente.
 */
function readMfa(payload: Record<string, unknown>): boolean | null {
  const value = payload.mfa
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function readPermVersion(payload: Record<string, unknown>): number | null {
  const direct = payload.permVersion
  if (typeof direct === 'number') return direct
  if (typeof direct === 'string' && direct.trim() !== '' && Number.isFinite(Number(direct))) {
    return Number(direct)
  }
  return null
}
