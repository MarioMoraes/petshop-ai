import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import {
  DEFAULT_TERM_VERSION,
  PERMISSION_KEYS,
  PLATFORM_TERM_SEEDS,
  TERM_KINDS,
  type PermissionKey,
  type RoleKey,
} from '@petshop/shared-types'

/**
 * Harness dos testes de integração.
 *
 * Sobe o app de verdade — hooks, handler de erro, RLS, triggers, banco — e substitui
 * só o ViaCEP, que é a única dependência externa. Assim os ACs são verificados
 * contra o comportamento real do sistema, e não contra dublês do próprio código.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_tutor'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

// Broker e cache ficam fora: os testes verificam o efeito no banco, e subir
// RabbitMQ/Redis por teste só adicionaria intermitência.
process.env.DISABLE_EVENTS = 'true'
// A grade não roda na suíte: um `setInterval` de um minuto é intermitência garantida.
process.env.DISABLE_JOBS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { loadEnv } = await import('../src/env.js')
const { setCepPort } = await import('../src/lib/cep.js')
const { clearTenantKeyCache, createTenantKey, withTenant } = await import('@petshop/db')

// ─── Dublê do ViaCEP ─────────────────────────────────────────────────────────

export interface FakeCepState {
  entries: Map<string, { street: string; district: string; city: string; state: string }>
  /** Quando definido, a consulta estoura — simula o provedor fora do ar. */
  failWith: Error | null
  calls: number
}

export const fakeCep: FakeCepState = { entries: new Map(), failWith: null, calls: 0 }

export function resetFakeCep(): void {
  fakeCep.entries.clear()
  fakeCep.failWith = null
  fakeCep.calls = 0
  fakeCep.entries.set('01310100', {
    street: 'Avenida Paulista',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'SP',
  })
}
resetFakeCep()

setCepPort({
  async lookup(zipCode) {
    fakeCep.calls += 1
    if (fakeCep.failWith) throw fakeCep.failWith
    const entry = fakeCep.entries.get(zipCode)
    return entry ? { zipCode, ...entry } : null
  },
})

// ─── App ─────────────────────────────────────────────────────────────────────

let app: FastifyInstance | null = null

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp()
  await app.ready()
  return app
}

export async function closeHarness(): Promise<void> {
  await app?.close()
  app = null
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
  // As DEKs são cacheadas por processo; sem limpar, o tenant seguinte reutilizaria
  // a chave do anterior e a decifragem falharia.
  clearTenantKeyCache()
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
}

/**
 * Cria tenant, usuário e DEK — o mínimo para o tutor-service funcionar. Usa o
 * cliente owner porque montar cenário não é o que está sob teste; a partir daí,
 * tudo passa pela API com RLS ativo.
 */
export async function givenTenant(name = 'Petshop Teste'): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug: `teste-${suffix}`,
      name,
      status: 'ACTIVE',
      plan: 'PRO',
      provisioningKey: `prov-${suffix}`,
      onboardingStep: 5,
      onboardingCompletedAt: new Date(),
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Atendente de Teste',
    },
  })

  await ownerPrisma.membership.create({
    data: { tenantId, userId: user.id, roleKey: 'TENANT_ADMIN' },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  /**
   * As três versões `1.0` da plataforma, como o provisionamento semeia (MOD-DOC-06).
   *
   * Sem elas nenhum tutor é criado: desde o MOD-DOC-06 toda linha de `tutor_consents`
   * tem a versão conferida contra `term_versions`. O fixture repete o que o
   * `seedTenantDomain` do identity-service faz, porque o tenant daqui nasce por INSERT
   * e não pelo provisionamento.
   */
  await ownerPrisma.termVersion.createMany({
    data: TERM_KINDS.map((kind) => ({
      tenantId,
      kind,
      version: DEFAULT_TERM_VERSION,
      title: PLATFORM_TERM_SEEDS[kind].title,
      body: PLATFORM_TERM_SEEDS[kind].body,
    })),
  })

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId }
}

/**
 * O endereço público do estabelecimento — sem ele, nenhum documento é emitido (AC-02
 * de MOD-DOC-01). Fica fora do `givenTenant` de propósito: é justamente o cenário do
 * tenant incompleto que um dos testes exercita.
 */
export async function givenIssuerSettings(fixture: TenantFixture): Promise<void> {
  await ownerPrisma.tenantSettings.create({
    data: {
      tenantId: fixture.tenantId,
      branding: { primaryColor: '#2f6f5a' },
      businessHours: {},
      addressZip: '01310100',
      addressStreet: 'Avenida Paulista',
      addressNumber: '1000',
      addressDistrict: 'Bela Vista',
      addressCity: 'São Paulo',
      addressState: 'SP',
      publicPhone: '11 3000-0000',
    },
  })
}

// ─── Requisições autenticadas ────────────────────────────────────────────────

export interface CallerOptions {
  clerkUserId: string
  userId?: string
  tenantId?: string
  role?: RoleKey
  permissions?: PermissionKey[]
  permVersion?: number
}

/** Monta os headers assinados que o gateway produziria. */
export function authHeaders(options: CallerOptions): Record<string, string> {
  const context: ServiceAuthContext = {
    clerkUserId: options.clerkUserId,
    permissions: options.permissions ?? [],
  }
  if (options.userId) context.userId = options.userId
  if (options.tenantId) context.tenantId = options.tenantId
  if (options.role) context.role = options.role
  if (options.permVersion !== undefined) context.permVersion = options.permVersion

  return signServiceHeaders(context, loadEnv().INTERNAL_SERVICE_SECRET)
}

export interface InjectOptions extends CallerOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
}

export async function callApi(options: InjectOptions) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    headers: authHeaders(options),
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/** Chamada como TENANT_ADMIN do tenant do fixture — o caso mais comum. */
export function asAdmin(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'TENANT_ADMIN' as const,
    permissions: [...PERMISSION_KEYS],
  }
}
