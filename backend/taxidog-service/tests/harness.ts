import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import {
  PERMISSION_KEYS,
  todayIn,
  zonedMidnight,
  type PermissionKey,
  type RoleKey,
} from '@petshop/shared-types'

/**
 * Harness dos testes de integração do Taxi Dog.
 *
 * Sobe o app de verdade — hooks, handler de erro, RLS, índices, banco — e não
 * substitui nada. É o índice único parcial `idx_taxi_rides_leg_alive` que prova o
 * AC-04, e a transação SERIALIZABLE de verdade que prova o RN-09; um mock provaria
 * apenas que o mock funciona.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_taxi'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

// Broker e cache ficam fora: os testes verificam o efeito no banco, e subir
// RabbitMQ/Redis por teste só adicionaria intermitência.
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
  clearTenantKeyCache()
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
      onboardingStep: 5,
      onboardingCompletedAt: new Date(),
      settings: {
        create: {
          timezone: 'America/Sao_Paulo',
          branding: {},
          businessHours: {},
        },
      },
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

export async function givenTutor(
  fixture: TenantFixture,
  options: { withAddress?: boolean; zipCode?: string } = {},
): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: 'Ana Souza',
        // Cifra de verdade, não `v1:x:x:x`: a rota do motorista **decifra** o
        // telefone, e um placeholder faria o teste passar por engano ao exercitar o
        // caminho de erro em vez do caminho normal.
        phoneEncrypted: await encryptForTenant(tx, fixture.tenantId, '+5511987654321'),
        phoneHash: `phone-${suffix}`,
      },
    })

    if (options.withAddress !== false) {
      // Cifrado com a **mesma** DEK do tenant: é o que permite a corrida copiar o
      // texto cifrado sem decifrar e recifrar (RN-11).
      const enc = (value: string) => encryptForTenant(tx, fixture.tenantId, value)
      await tx.tutorAddress.create({
        data: {
          tenantId: fixture.tenantId,
          tutorId: tutor.id,
          label: 'Casa',
          zipCode: options.zipCode ?? '04567000',
          streetEncrypted: await enc('Rua das Acácias'),
          numberEncrypted: await enc('120'),
          complementEncrypted: await enc('apto 31'),
          accessNotes: await enc('Portão azul, interfone 12'),
          district: 'Moema',
          city: 'São Paulo',
          state: 'SP',
          isPrimary: true,
        },
      })
    }

    return tutor.id
  })
}

export async function givenPet(fixture: TenantFixture, tutorId: string): Promise<string> {
  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
  ])

  return withTenant(fixture.tenantId, async (tx) => {
    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: 'Thor',
        speciesId: species.id,
        sizeId: size.id,
        status: 'ACTIVE',
      },
    })
    await tx.petTutor.create({
      data: { tenantId: fixture.tenantId, petId: pet.id, tutorId, role: 'PRIMARY' },
    })
    return pet.id
  })
}

/**
 * Motorista com jornada. `weekday` cobre a semana inteira de propósito: os testes
 * marcam corridas em datas relativas a "agora", e restringir os dias faria a suíte
 * passar ou falhar conforme o dia em que roda.
 */
export async function givenDriver(
  fixture: TenantFixture,
  options: {
    name?: string
    capacity?: number
    userId?: string
    /** Sem jornada nenhuma: é assim que se prova o `OUT_OF_SCHEDULE`. */
    noSchedule?: boolean
  } = {},
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const driver = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: options.name ?? 'João Motorista',
        roleKey: 'DRIVER',
        maxConcurrentPets: options.capacity ?? 4,
        ...(options.userId ? { userId: options.userId } : {}),
      },
    })

    if (!options.noSchedule) {
      await tx.professionalSchedule.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          tenantId: fixture.tenantId,
          professionalId: driver.id,
          weekday,
          // 00:00–23:59 no fuso do tenant: a jornada não é o que está sob teste,
          // exceto no caso que a remove de propósito.
          startsAtMin: 0,
          endsAtMin: 1439,
        })),
      })
    }

    return driver.id
  })
}

export async function givenVehicle(
  fixture: TenantFixture,
  options: { capacity?: number; plate?: string } = {},
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const vehicle = await tx.taxiVehicle.create({
      data: {
        tenantId: fixture.tenantId,
        plate: options.plate ?? 'ABC1D23',
        label: 'Van branca',
        petCapacity: options.capacity ?? 4,
      },
    })
    return vehicle.id
  })
}

/** O serviço de catálogo, categoria TAXI, que ancora a cobrança (RN-05). */
export async function givenTaxiService(fixture: TenantFixture): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: 'Taxi Dog',
        category: 'TAXI',
        baseDurationMin: 0,
      },
    })
    return service.id
  })
}

/**
 * O dia civil de hoje no fuso do tenant, e um horário dentro dele.
 *
 * As janelas dos testes de painel e de rota **não** podem ser calculadas a partir de
 * "agora + N horas": rodando a suíte à noite, a janela atravessaria a meia-noite
 * local, e aí ela deixa de caber em uma faixa de jornada — o `checkDriverWindow`
 * recusaria, corretamente, e o teste falharia por um motivo que não é o que ele
 * pretende provar.
 */
export const TEST_TIMEZONE = 'America/Sao_Paulo'

export function localToday(): string {
  return todayIn(TEST_TIMEZONE)
}

export function localDayToday(hour: number): Date {
  return new Date(zonedMidnight(localToday(), TEST_TIMEZONE).getTime() + hour * 3_600_000)
}

export interface AppointmentFixture {
  appointmentId: string
  petId: string
  tutorId: string
  professionalId: string
  startsAt: Date
  endsAt: Date
}

/**
 * Um agendamento futuro com um item de banho. Futuro porque a corrida de ida precisa
 * caber **antes** do início do atendimento (AC-03), e um agendamento no passado
 * tornaria toda janela de coleta inválida.
 */
export async function givenAppointment(
  fixture: TenantFixture,
  options: {
    tutorId?: string
    status?: 'CONFIRMED' | 'COMPLETED'
    hoursFromNow?: number
    /** Vence `hoursFromNow`. Use com `localDayToday()` para ficar dentro do dia civil. */
    startsAt?: Date
  } = {},
): Promise<AppointmentFixture> {
  const tutorId = options.tutorId ?? (await givenTutor(fixture))
  const petId = await givenPet(fixture, tutorId)

  const professionalId = await withTenant(fixture.tenantId, async (tx) => {
    const groomer = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: `Bruna Tosadora ${randomUUID().slice(0, 8)}`,
        roleKey: 'GROOMER',
      },
    })
    return groomer.id
  })

  // Nome único por chamada: `services` tem unicidade por tenant, e um teste que cria
  // dois agendamentos no mesmo tenant colidiria no segundo "Banho".
  const serviceId = await withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: `Banho ${randomUUID().slice(0, 8)}`,
        category: 'BATH',
        baseDurationMin: 60,
      },
    })
    return service.id
  })

  const startsAt =
    options.startsAt ?? new Date(Date.now() + (options.hoursFromNow ?? 24) * 3_600_000)
  const endsAt = new Date(startsAt.getTime() + 3_600_000)

  const appointmentId = await withTenant(fixture.tenantId, async (tx) => {
    const appointment = await tx.appointment.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        professionalId,
        startsAt,
        endsAt,
        status: options.status ?? 'CONFIRMED',
        totalCents: BigInt(8000),
        items: {
          create: [
            {
              tenantId: fixture.tenantId,
              serviceId,
              label: 'Banho',
              priceCents: BigInt(8000),
              durationMin: 60,
            },
          ],
        },
      },
      select: { id: true },
    })
    return appointment.id
  })

  return { appointmentId, petId, tutorId, professionalId, startsAt, endsAt }
}

/** Liga o módulo e aponta o serviço de cobrança — o pré-requisito de tudo (RN-22). */
export async function enableTaxi(
  fixture: TenantFixture,
  options: { defaultPriceCents?: number; blockOutsideZones?: boolean } = {},
): Promise<string> {
  const serviceId = await givenTaxiService(fixture)
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.taxiSettings.create({
      data: {
        tenantId: fixture.tenantId,
        enabled: true,
        taxiServiceId: serviceId,
        defaultPriceCents: BigInt(options.defaultPriceCents ?? 2000),
        blockOutsideZones: options.blockOutsideZones ?? false,
      },
    })
  })
  return serviceId
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

export function asAdmin(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'TENANT_ADMIN' as const,
    permissions: [...PERMISSION_KEYS],
  }
}

/** Recepção: opera tudo, mas não configura zona, frota nem preço (§9). */
export function asReceptionist(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'RECEPTIONIST' as const,
    permissions: ['taxi:operate', 'schedule:write_all', 'schedule:read_all'] as PermissionKey[],
  }
}

/** Motorista: opera só as **próprias** corridas (RN-19). */
export async function asDriver(fixture: TenantFixture, driverUserId: string) {
  const user = await ownerPrisma.user.findUniqueOrThrow({ where: { id: driverUserId } })
  return {
    clerkUserId: user.clerkUserId,
    userId: driverUserId,
    tenantId: fixture.tenantId,
    role: 'DRIVER' as const,
    permissions: ['taxi:operate'] as PermissionKey[],
  }
}

/** Um usuário a mais no tenant, para o motorista ter login próprio. */
export async function givenUser(fixture: TenantFixture, roleKey: RoleKey): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Motorista de Teste',
    },
  })
  await ownerPrisma.membership.create({
    data: { tenantId: fixture.tenantId, userId: user.id, roleKey },
  })
  return user.id
}
