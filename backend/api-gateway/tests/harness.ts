import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import Fastify, { type FastifyInstance } from 'fastify'
import type { SessionClaims } from '../src/auth/clerk-token.js'

/**
 * Harness do gateway.
 *
 * Sobe o gateway de verdade contra o banco de testes, com dois dublês nas pontas:
 * o verificador de token do Clerk e um serviço de destino que só devolve o que
 * recebeu — é assim que dá para inspecionar exatamente o contexto que o gateway
 * assina e encaminha.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
// Banco de testes próprio deste pacote: o turbo roda as suítes em paralelo.
process.env.TEST_DATABASE_NAME = 'petshop_test_gateway'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'
process.env.CLERK_SECRET_KEY ||= 'sk_test_harness'

export const ownerPrisma: OwnerClient = createOwnerClient()

// ─── Serviço de destino falso ────────────────────────────────────────────────

export interface EchoedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

export const echoed: EchoedRequest[] = []
let upstream: FastifyInstance | null = null
let upstreamUrl = ''

async function startUpstream(): Promise<string> {
  if (upstreamUrl) return upstreamUrl
  upstream = Fastify({ logger: false })
  // O eco também precisa aceitar corpo binário: é assim que o upload de foto
  // (MOD-PET-04) chega, e é o que o teste de passagem confere byte a byte.
  upstream.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: 32 * 1024 * 1024 },
    (_request, body, done) => {
      done(null, body)
    },
  )
  upstream.all('/*', async (request, reply) => {
    echoed.push({
      method: request.method,
      url: request.url,
      headers: request.headers as Record<string, string>,
      body: request.body,
    })
    return reply.status(200).send({ ok: true, url: request.url })
  })
  await upstream.listen({ port: 0, host: '127.0.0.1' })
  const address = upstream.server.address()
  if (!address || typeof address === 'string') throw new Error('upstream sem porta')
  upstreamUrl = `http://127.0.0.1:${address.port}`
  return upstreamUrl
}

// ─── Gateway ─────────────────────────────────────────────────────────────────

let gateway: FastifyInstance | null = null

export async function getGateway(): Promise<FastifyInstance> {
  if (gateway) return gateway
  // Todos os serviços apontam para o mesmo eco: o que está sob teste é o roteamento
  // e a assinatura do contexto, não quem responde do outro lado.
  const upstreamAddress = await startUpstream()
  process.env.IDENTITY_SERVICE_URL = upstreamAddress
  process.env.TUTOR_SERVICE_URL = upstreamAddress
  process.env.PET_SERVICE_URL = upstreamAddress

  const { resetEnvCache } = await import('../src/env.js')
  resetEnvCache()

  const { buildApp } = await import('../src/app.js')
  gateway = await buildApp()
  await gateway.ready()
  return gateway
}

export async function closeHarness(): Promise<void> {
  await gateway?.close()
  await upstream?.close()
  gateway = null
  upstream = null
  upstreamUrl = ''
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
  echoed.length = 0
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

const tokens = new Map<string, SessionClaims>()

/** Registra um token válido no verificador falso e devolve a string do token. */
export function givenToken(claims: {
  clerkUserId: string
  clerkOrgId?: string | null
  permVersion?: number | null
}): string {
  const token = `tok_${randomBytes(8).toString('hex')}`
  tokens.set(token, {
    clerkUserId: claims.clerkUserId,
    clerkOrgId: claims.clerkOrgId ?? null,
    permVersion: claims.permVersion ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })
  return token
}

const { setTokenVerifier, InvalidTokenError } = await import('../src/auth/clerk-token.js')

setTokenVerifier(async (token) => {
  const claims = tokens.get(token)
  if (!claims) throw new InvalidTokenError('Token desconhecido')
  return claims
})

// ─── Cenário no banco ────────────────────────────────────────────────────────

export interface SeededTenant {
  tenantId: string
  clerkOrgId: string
  slug: string
}

export async function seedTenant(
  slug: string,
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' = 'ACTIVE',
): Promise<SeededTenant> {
  const tenantId = randomUUID()
  const clerkOrgId = `org_${randomBytes(8).toString('hex')}`
  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug,
      name: `Petshop ${slug}`,
      status,
      plan: 'STARTER',
      provisioningKey: randomUUID(),
      clerkOrgId,
    },
  })
  return { tenantId, clerkOrgId, slug }
}

export async function seedMember(
  tenantId: string,
  roleKey: string,
): Promise<{ userId: string; clerkUserId: string; membershipId: string }> {
  const { encryptPlatform, hashEmail } = await import('@petshop/db')
  const email = `${randomBytes(4).toString('hex')}@petshop.test`
  const clerkUserId = `user_${randomBytes(8).toString('hex')}`
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId,
      emailEncrypted: encryptPlatform(email),
      emailHash: hashEmail(email),
      fullName: 'Membro de Teste',
    },
  })
  const membership = await ownerPrisma.membership.create({
    data: { tenantId, userId: user.id, roleKey, status: 'ACTIVE' },
  })
  return { userId: user.id, clerkUserId, membershipId: membership.id }
}

export function lastEchoed(): EchoedRequest {
  const last = echoed.at(-1)
  if (!last) throw new Error('nenhuma requisição chegou ao serviço de destino')
  return last
}
