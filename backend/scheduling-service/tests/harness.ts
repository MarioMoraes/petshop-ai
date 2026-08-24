import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import { PERMISSION_KEYS, type PermissionKey, type RoleKey } from '@petshop/shared-types'

/**
 * Harness dos testes de integração.
 *
 * Sobe o app de verdade — hooks, handler de erro, RLS, constraints, banco. A única
 * coisa dublada é a porta de `appointments`, e só nos testes que exercitam as regras
 * que dependem dela: a tabela ainda não existe, e o dublê aqui representa a fatia 2,
 * não substitui algo que já funciona.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_scheduling'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

// Broker e cache ficam fora: os testes verificam o efeito no banco, e subir
// RabbitMQ/Redis por teste só adicionaria intermitência.
process.env.DISABLE_EVENTS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { loadEnv } = await import('../src/env.js')
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
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  // `truncateBusinessTables` preserva o catálogo global: ele é semeado uma vez, no
  // global-setup, e recriá-lo a cada teste custaria mais que a suíte inteira.
  await truncateBusinessTables(ownerPrisma)
  clearTenantKeyCache()
  const { resetAppointmentsPort } = await import('../src/modules/catalog/port.js')
  resetAppointmentsPort()
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
}

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
      onboardingStep: 4,
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

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId }
}

/**
 * Horário de funcionamento do tenant, para o AC-03 da jornada. Só quem testa o aviso
 * precisa dele — o resto da suíte não depende de `tenant_settings` existir.
 */
export async function givenBusinessHours(
  fixture: TenantFixture,
  hours: Record<string, { open: string; close: string }>,
): Promise<void> {
  await ownerPrisma.tenantSettings.create({
    // `branding` é obrigatório no modelo (etapa 4 do onboarding). Vazio serve: o que
    // este fixture existe para configurar é o horário.
    data: { tenantId: fixture.tenantId, businessHours: hours, branding: {} },
  })
}

/** Os portes são catálogo global (MOD-PET-03); a agenda só os referencia. */
export async function sizeIds(): Promise<Record<'SMALL' | 'MEDIUM' | 'LARGE' | 'GIANT', string>> {
  const sizes = await ownerPrisma.size.findMany({ where: { tenantId: null } })
  const byKey = Object.fromEntries(sizes.map((size) => [size.key, size.id]))
  return {
    SMALL: byKey.SMALL ?? '',
    MEDIUM: byKey.MEDIUM ?? '',
    LARGE: byKey.LARGE ?? '',
    GIANT: byKey.GIANT ?? '',
  }
}

/**
 * Pet com responsável principal, criado direto no banco.
 *
 * O scheduling-service lê pets e tutores mas não os cria — quem cadastra são os
 * outros serviços, e chamá-los daqui acoplaria as suítes. O que importa para a agenda
 * é a linha existir no tenant certo, com porte e pelagem, que são o que decide a
 * duração.
 */
export async function givenPet(
  fixture: TenantFixture,
  options: { name?: string; sizeKey?: string; coatKey?: string | null; status?: string } = {},
): Promise<{ petId: string; tutorId: string }> {
  const [species, size, coat] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({
      where: { key: options.sizeKey ?? 'LARGE', tenantId: null },
    }),
    options.coatKey === null
      ? Promise.resolve(null)
      : ownerPrisma.coat.findFirstOrThrow({
          where: { key: options.coatKey ?? 'SHORT', tenantId: null },
        }),
  ])

  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        personType: 'PF',
        fullName: `Tutor de ${options.name ?? 'Thor'}`,
        // A agenda não lê telefone; o que importa é a linha existir com o hash único
        // que o índice de busca exige.
        phoneEncrypted: 'v1:teste',
        phoneHash: randomUUID(),
        status: 'ACTIVE',
      },
    })

    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Thor',
        speciesId: species.id,
        sizeId: size.id,
        ...(coat ? { coatId: coat.id } : {}),
        status: (options.status ?? 'ACTIVE') as 'ACTIVE',
      },
    })

    await tx.petTutor.create({
      data: {
        tenantId: fixture.tenantId,
        petId: pet.id,
        tutorId: tutor.id,
        role: 'PRIMARY',
      },
    })

    return { petId: pet.id, tutorId: tutor.id }
  })
}

/** Serviço com preço e duração em todos os portes. */
export async function givenService(
  fixture: TenantFixture,
  options: { name?: string; category?: string; durationMin?: number; priceCents?: number } = {},
): Promise<string> {
  const sizes = await ownerPrisma.size.findMany({ where: { tenantId: null } })

  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Banho',
        category: (options.category ?? 'BATH') as 'BATH',
        baseDurationMin: options.durationMin ?? 60,
        pricing: {
          create: sizes.map((size) => ({
            tenantId: fixture.tenantId,
            sizeId: size.id,
            priceCents: BigInt(options.priceCents ?? 7000),
            durationMin: options.durationMin ?? 60,
          })),
        },
      },
    })
    return service.id
  })
}

/**
 * Profissional habilitado nos serviços, com jornada.
 *
 * A jornada padrão cobre a semana inteira das 08:00 às 18:00 **em UTC**: os testes
 * raciocinam em instantes, e misturar fuso aqui só esconderia o que está sendo
 * verificado.
 */
export async function givenProfessional(
  fixture: TenantFixture,
  options: {
    name?: string
    serviceIds?: string[]
    maxConcurrentPets?: number
    windows?: { weekday: number; startsAtMin: number; endsAtMin: number }[]
  } = {},
): Promise<string> {
  const windows =
    options.windows ??
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startsAtMin: 480, endsAtMin: 1080 }))

  return withTenant(fixture.tenantId, async (tx) => {
    const professional = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: options.name ?? 'Ana',
        roleKey: 'BATHER',
        maxConcurrentPets: options.maxConcurrentPets ?? 1,
        schedules: {
          create: windows.map((window) => ({ tenantId: fixture.tenantId, ...window })),
        },
        services: {
          create: (options.serviceIds ?? []).map((serviceId) => ({
            tenantId: fixture.tenantId,
            serviceId,
          })),
        },
      },
    })
    return professional.id
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

/** Recepção: agenda o dia inteiro, mas não mexe no catálogo (§9). */
export function asReceptionist(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'RECEPTIONIST' as const,
    permissions: PERMISSION_KEYS.filter((key) => key !== 'schedule:manage_catalog'),
  }
}
