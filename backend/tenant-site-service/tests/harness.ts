import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import { PERMISSION_KEYS, type PermissionKey, type RoleKey } from '@petshop/shared-types'

/**
 * Harness do site do estabelecimento.
 *
 * Sobe o app de verdade — os dois escopos do Fastify, o handler de erro, o RLS e o
 * banco. A separação entre superfície pública e administrativa é a decisão de
 * segurança do serviço, e ela **só existe na montagem do app**: um harness que
 * chamasse as funções de módulo direto não provaria nada sobre ela.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_site'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

// Broker e cache ficam fora: os testes verificam o efeito no banco, e subir
// RabbitMQ/Redis por teste só adicionaria intermitência.
//
// **Sem Redis, o rate limit libera todo envio** (`withinRateLimit` degrada aberto de
// propósito: lead perdido é cliente perdido). O teste do 429 liga um dublê.
process.env.DISABLE_EVENTS = 'true'
process.env.DISABLE_JOBS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { loadEnv } = await import('../src/env.js')
const { setStoragePort } = await import('../src/lib/storage.js')
const { clearTenantKeyCache, createTenantKey, withTenant } = await import('@petshop/db')

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
  setStoragePort(null)
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
  clearTenantKeyCache()
}

/** Storage em memória: o upload é exercitado de ponta a ponta, sem bucket. */
export function useMemoryStorage(): Map<string, { body: Buffer; contentType: string }> {
  const objects = new Map<string, { body: Buffer; contentType: string }>()
  setStoragePort({
    async put(key, body, contentType) {
      objects.set(key, { body, contentType })
    },
    async read(key) {
      return objects.get(key) ?? null
    },
    async remove(keys) {
      for (const key of keys) objects.delete(key)
    },
  })
  return objects
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  slug: string
  userId: string
  clerkUserId: string
}

export interface TenantOptions {
  /** RN-06: o site acompanha o estado da conta. */
  status?: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED'
  /** AC-02 de MOD-SITE-01: sem endereço não se publica. */
  withAddress?: boolean
  withContact?: boolean
  onlineBookingEnabled?: boolean
}

export async function givenTenant(options: TenantOptions = {}): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const slug = `teste-${suffix}`
  const withAddress = options.withAddress ?? true
  const withContact = options.withContact ?? true

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug,
      name: 'Petshop do João',
      status: options.status ?? 'ACTIVE',
      plan: 'PRO',
      provisioningKey: `prov-${suffix}`,
      onboardingStep: 4,
      onboardingCompletedAt: new Date(),
      settings: {
        create: {
          timezone: 'America/Sao_Paulo',
          branding: { primaryColor: '#2E7D32' },
          businessHours: {
            monday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            tuesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            wednesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            thursday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            friday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            saturday: { closed: false, opensAt: '08:00', closesAt: '13:00' },
            sunday: { closed: true, opensAt: '08:00', closesAt: '13:00' },
          },
          onlineBookingEnabled: options.onlineBookingEnabled ?? true,
          ...(withAddress
            ? {
                addressZip: '04567000',
                addressStreet: 'Rua das Acácias',
                addressNumber: '120',
                addressDistrict: 'Moema',
                addressCity: 'São Paulo',
                addressState: 'SP',
              }
            : {}),
          ...(withContact ? { publicPhone: '+551132654321', publicWhatsapp: '+5511987654321' } : {}),
        },
      },
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Administrador de Teste',
    },
  })

  await ownerPrisma.membership.create({
    data: { tenantId, userId: user.id, roleKey: 'TENANT_ADMIN' },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return { tenantId, slug, userId: user.id, clerkUserId: user.clerkUserId }
}

export interface ServiceOptions {
  name?: string
  category?: 'BATH' | 'GROOMING' | 'VET' | 'TAXI'
  active?: boolean
  showOnSite?: boolean
  priceCents?: number[]
}

/** Um serviço de catálogo, opcionalmente com tabela de preços por porte. */
export async function givenService(
  fixture: TenantFixture,
  options: ServiceOptions = {},
): Promise<string> {
  const sizes = await ownerPrisma.size.findMany({ where: { tenantId: null }, take: 3 })

  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Banho',
        category: options.category ?? 'BATH',
        baseDurationMin: 60,
        active: options.active ?? true,
        showOnSite: options.showOnSite ?? true,
      },
    })

    for (const [index, priceCents] of (options.priceCents ?? []).entries()) {
      const size = sizes[index]
      if (!size) break
      await tx.servicePricing.create({
        data: {
          tenantId: fixture.tenantId,
          serviceId: service.id,
          sizeId: size.id,
          priceCents: BigInt(priceCents),
          durationMin: 60,
        },
      })
    }

    return service.id
  })
}

export async function givenTutor(fixture: TenantFixture, phoneHash: string): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: 'Ana Souza',
        phoneEncrypted: 'v1:x:x:x',
        phoneHash,
      },
    })
    return tutor.id
  })
}

// ─── Requisições ─────────────────────────────────────────────────────────────

export interface CallerOptions {
  clerkUserId: string
  userId?: string
  tenantId?: string
  role?: RoleKey
  permissions?: PermissionKey[]
}

export function authHeaders(options: CallerOptions): Record<string, string> {
  const context: ServiceAuthContext = {
    clerkUserId: options.clerkUserId,
    permissions: options.permissions ?? [],
  }
  if (options.userId) context.userId = options.userId
  if (options.tenantId) context.tenantId = options.tenantId
  if (options.role) context.role = options.role

  return signServiceHeaders(context, loadEnv().INTERNAL_SERVICE_SECRET)
}

export interface InjectOptions extends CallerOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
}

/** Chamada autenticada, como o gateway a faria. */
export async function callApi(options: InjectOptions) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    headers: authHeaders(options),
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/** Chamada **anônima**, como o Next a faz ao renderizar a página. */
export async function callPublic(options: {
  method: 'GET' | 'POST'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

export function asAdmin(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'TENANT_ADMIN' as const,
    permissions: [...PERMISSION_KEYS],
  }
}

/** Recepção: trabalha os contatos, não publica o site (§9). */
export function asReceptionist(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'RECEPTIONIST' as const,
    permissions: ['site:read_leads', 'tutor:create'] as PermissionKey[],
  }
}
