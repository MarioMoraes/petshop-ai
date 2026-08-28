import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import { PERMISSION_KEYS, type PermissionKey, type RoleKey } from '@petshop/shared-types'

/**
 * Harness do crm-automation-service.
 *
 * O dublê aqui é a **porta do messaging-service** — não o provedor de e-mail. É o que
 * permite provar a regra de negócio deste serviço (quem recebe lembrete, quando, com
 * que variáveis) sem subir um segundo processo HTTP. O que o messaging faz com o
 * pedido tem suíte própria, do outro lado.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_crm'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

process.env.DISABLE_EVENTS = 'true'
process.env.DISABLE_JOBS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { loadEnv } = await import('../src/env.js')
const { clearTenantKeyCache, createTenantKey, encryptForTenant, withTenant } = await import(
  '@petshop/db'
)
const { setMessagingPort } = await import('../src/modules/crm/messaging-port.js')
type EnqueueRequest = import('../src/modules/crm/messaging-port.js').EnqueueRequest

let app: FastifyInstance | null = null

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp()
  await app.ready()
  return app
}

export async function closeHarness(): Promise<void> {
  await app?.close()
  app = null
  setMessagingPort(null)
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
  clearTenantKeyCache()
}

// ─── Dublê da porta ──────────────────────────────────────────────────────────

export interface FakeMessaging {
  requests: EnqueueRequest[]
  /** Faz o próximo enfileiramento falhar, como o messaging fora do ar. */
  failNext(): void
}

export function installFakeMessagingPort(): FakeMessaging {
  const requests: EnqueueRequest[] = []
  let fail = false

  setMessagingPort({
    async enqueue(request) {
      if (fail) {
        fail = false
        return false
      }
      requests.push(request)
      return true
    },
  })

  return {
    requests,
    failNext() {
      fail = true
    },
  }
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
}

export const TEST_TIMEZONE = 'America/Sao_Paulo'

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
      settings: { create: { timezone: TEST_TIMEZONE, branding: {}, businessHours: {} } },
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

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId }
}

export interface AppointmentFixture {
  appointmentId: string
  tutorId: string
  petId: string
}

/**
 * Um agendamento futuro, com pet, tutor, profissional e um item de banho.
 *
 * `hoursFromNow` é o eixo dos testes de lembrete: a varredura busca por **intervalo**,
 * e é assim que se prova que ela pega o que está na janela e ignora o resto.
 */
export async function givenAppointment(
  fixture: TenantFixture,
  options: { hoursFromNow?: number; tutorId?: string; petName?: string } = {},
): Promise<AppointmentFixture> {
  const suffix = randomUUID().slice(0, 8)

  return withTenant(fixture.tenantId, async (tx) => {
    const tutorId =
      options.tutorId ??
      (
        await tx.tutor.create({
          data: {
            tenantId: fixture.tenantId,
            fullName: 'Ana Souza',
            phoneEncrypted: await encryptForTenant(tx, fixture.tenantId, '+5511987654321'),
            phoneHash: `phone-${suffix}`,
            emailEncrypted: await encryptForTenant(tx, fixture.tenantId, `ana-${suffix}@x.com`),
            emailHash: `email-${suffix}`,
          },
          select: { id: true },
        })
      ).id

    const [species, size] = await Promise.all([
      ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
      ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
    ])

    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.petName ?? 'Thor',
        speciesId: species.id,
        sizeId: size.id,
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    await tx.petTutor.create({
      data: { tenantId: fixture.tenantId, petId: pet.id, tutorId, role: 'PRIMARY' },
    })

    const professional = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: 'Bruna Tosadora',
        roleKey: 'GROOMER',
      },
      select: { id: true },
    })

    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: `Banho ${suffix}`,
        category: 'BATH',
        baseDurationMin: 60,
      },
      select: { id: true },
    })

    const startsAt = new Date(Date.now() + (options.hoursFromNow ?? 24.5) * 3_600_000)
    const appointment = await tx.appointment.create({
      data: {
        tenantId: fixture.tenantId,
        petId: pet.id,
        tutorId,
        professionalId: professional.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        status: 'CONFIRMED',
        totalCents: BigInt(8000),
        items: {
          create: [
            {
              tenantId: fixture.tenantId,
              serviceId: service.id,
              label: 'Banho',
              priceCents: BigInt(8000),
              durationMin: 60,
            },
          ],
        },
      },
      select: { id: true },
    })

    return { appointmentId: appointment.id, tutorId, petId: pet.id }
  })
}

// ─── Requisições autenticadas ────────────────────────────────────────────────

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

export async function callApi(options: InjectOptions) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    headers: authHeaders(options),
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

export function asReceptionist(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'RECEPTIONIST' as const,
    permissions: ['crm:read'] as PermissionKey[],
  }
}
