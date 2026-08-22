import { createPublicKey } from 'node:crypto'
import { verifyToken } from '@clerk/backend'
import { listFromEnv, loadEnv } from '../env.js'
import { logger } from '../lib/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../lib/redis.js'

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

export type TokenVerifier = (token: string) => Promise<SessionClaims>

let verifier: TokenVerifier | null = null

/** Injeta um verificador. Usado pelos testes; nunca em produção. */
export function setTokenVerifier(next: TokenVerifier | null): void {
  verifier = next
}

export function verifySessionToken(token: string): Promise<SessionClaims> {
  return (verifier ?? verifyWithClerk)(token)
}

async function verifyWithClerk(token: string): Promise<SessionClaims> {
  const env = loadEnv()
  const authorizedParties = listFromEnv(env.CLERK_AUTHORIZED_PARTIES)

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
    expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
  }
}

function readPermVersion(payload: Record<string, unknown>): number | null {
  const direct = payload.permVersion
  if (typeof direct === 'number') return direct
  if (typeof direct === 'string' && direct.trim() !== '' && Number.isFinite(Number(direct))) {
    return Number(direct)
  }
  return null
}
