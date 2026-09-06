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
  /** Faz o próximo enfileiramento voltar bloqueado, com o motivo informado. */
  blockNext(reason: string): void
}

export function installFakeMessagingPort(): FakeMessaging {
  const requests: EnqueueRequest[] = []
  let fail = false
  let block: string | null = null

  setMessagingPort({
    async enqueue(request) {
      if (fail) {
        fail = false
        return null
      }
      requests.push(request)

      if (block) {
        const reason = block
        block = null
        return { messageId: randomUUID(), status: 'BLOCKED', blockReason: reason }
      }

      return { messageId: randomUUID(), status: 'QUEUED', blockReason: null }
    },
  })

  return {
    requests,
    failNext() {
      fail = true
    },
    blockNext(reason: string) {
      block = reason
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

/**
 * Uma corrida do Taxi Dog pendurada num agendamento (MOD-CRM-09).
 *
 * `windowStartsAt`/`windowEndsAt` são a promessa que o tutor recebe — o texto do aviso
 * diz "entre 8h e 9h", e é daqui que sai.
 */
export async function givenTaxiRide(
  fixture: TenantFixture,
  appointment: AppointmentFixture,
  options: { leg?: 'PICKUP' | 'DROPOFF'; failureReason?: string; window?: [Date, Date] } = {},
): Promise<string> {
  const [start, end] = options.window ?? [
    new Date('2026-09-03T11:00:00Z'),
    new Date('2026-09-03T12:00:00Z'),
  ]

  return withTenant(fixture.tenantId, async (tx) => {
    const ride = await tx.taxiRide.create({
      data: {
        tenantId: fixture.tenantId,
        appointmentId: appointment.appointmentId,
        petId: appointment.petId,
        tutorId: appointment.tutorId,
        leg: options.leg ?? 'PICKUP',
        status: 'REQUESTED',
        windowStartsAt: start,
        windowEndsAt: end,
        // Snapshot cifrado do endereço (§4 do MOD-TAXI): a corrida guarda para onde
        // ir, e não uma FK para um cadastro que pode mudar depois.
        zipCode: '01310100',
        streetEncrypted: await encryptForTenant(tx, fixture.tenantId, 'Avenida Paulista'),
        numberEncrypted: await encryptForTenant(tx, fixture.tenantId, '1000'),
        district: 'Bela Vista',
        city: 'São Paulo',
        state: 'SP',
        priceCents: BigInt(2500),
        ...(options.failureReason
          ? { failureReason: options.failureReason as 'NO_ONE_HOME' }
          : {}),
      },
      select: { id: true },
    })
    return ride.id
  })
}

// ─── Cenário da fatia 3 ──────────────────────────────────────────────────────

export interface TutorFixture {
  tutorId: string
  petId: string
}

/**
 * Um tutor com um pet, consentimento de marketing e contato.
 *
 * O consentimento é `BOTH` por padrão porque **ausência de registro não é
 * consentimento** (LGPD art. 8º, AC-03 de MOD-CRM-04): sem a linha, todo teste de
 * campanha veria o alvo pulado com `NO_CONSENT` e nenhum deles provaria nada. Quem quiser
 * o caso contrário passa `marketing: false`.
 */
export async function givenTutorWithPet(
  fixture: TenantFixture,
  options: {
    name?: string
    tutorBirthDate?: string
    petBirthDate?: string
    petBirthPrecision?: 'EXACT' | 'ESTIMATED' | 'UNKNOWN'
    petStatus?: 'ACTIVE' | 'DECEASED'
    marketing?: boolean
    balanceCents?: number
    lastAttendanceDaysAgo?: number
    withContact?: boolean
  } = {},
): Promise<TutorFixture> {
  const suffix = randomUUID().slice(0, 8)
  const withContact = options.withContact ?? true

  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: options.name ?? `Tutor ${suffix}`,
        // `phone_encrypted` é NOT NULL no schema. Um tutor "sem contato" é o que tem o
        // campo **vazio** — é assim que a cascata de `recipient.ts` o enxerga, e um
        // fixture que omitisse a coluna nem gravaria.
        phoneEncrypted: await encryptForTenant(
          tx,
          fixture.tenantId,
          withContact ? '+5511987654321' : '',
        ),
        phoneHash: `phone-${suffix}`,
        ...(withContact
          ? {
              emailEncrypted: await encryptForTenant(tx, fixture.tenantId, `t-${suffix}@x.com`),
              emailHash: `email-${suffix}`,
            }
          : {}),
        ...(options.tutorBirthDate ? { birthDate: new Date(`${options.tutorBirthDate}T00:00:00Z`) } : {}),
        balanceCents: options.balanceCents ?? 0,
        ...(options.lastAttendanceDaysAgo !== undefined
          ? {
              lastAttendanceAt: new Date(
                Date.now() - options.lastAttendanceDaysAgo * 24 * 3_600_000,
              ),
            }
          : {}),
      },
      select: { id: true },
    })

    if (options.marketing !== false) {
      await tx.tutorConsent.create({
        data: {
          tenantId: fixture.tenantId,
          tutorId: tutor.id,
          channel: 'WHATSAPP',
          purpose: 'BOTH',
          granted: true,
          version: '1.0',
          source: 'STAFF_FORM',
        },
      })
    }

    const [species, size] = await Promise.all([
      ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
      ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
    ])

    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: `Rex ${suffix}`,
        speciesId: species.id,
        sizeId: size.id,
        status: options.petStatus ?? 'ACTIVE',
        ...(options.petBirthDate
          ? {
              birthDate: new Date(`${options.petBirthDate}T00:00:00Z`),
              birthDatePrecision: options.petBirthPrecision ?? 'EXACT',
            }
          : {}),
      },
      select: { id: true },
    })

    await tx.petTutor.create({
      data: { tenantId: fixture.tenantId, petId: pet.id, tutorId: tutor.id, role: 'PRIMARY' },
    })

    return { tutorId: tutor.id, petId: pet.id }
  })
}

/**
 * Um débito em aberto, com a idade pedida.
 *
 * `occurred_at` é o que envelhece a dívida (RN-23), e é sobre ele que a régua conta os
 * dias — a mesma leitura do relatório de contas a receber.
 */
export async function givenOpenDebt(
  fixture: TenantFixture,
  tutorId: string,
  options: { amountCents: number; daysAgo: number },
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const account =
      (await tx.ledgerAccount.findFirst({ where: { tutorId }, select: { id: true } })) ??
      (await tx.ledgerAccount.create({
        data: { tenantId: fixture.tenantId, tutorId },
        select: { id: true },
      }))

    const occurredAt = new Date(Date.now() - options.daysAgo * 24 * 3_600_000)
    const entry = await tx.ledgerEntry.create({
      data: {
        tenantId: fixture.tenantId,
        accountId: account.id,
        tutorId,
        direction: 'DEBIT',
        amountCents: BigInt(options.amountCents),
        balanceAfterCents: BigInt(-options.amountCents),
        category: 'SERVICE',
        description: 'Banho',
        sourceType: 'MANUAL',
        occurredAt,
      },
      select: { id: true },
    })

    // O denormalizado é escrito por consumidor de evento em produção; no teste, à mão.
    await tx.tutor.update({
      where: { id: tutorId },
      data: { balanceCents: { decrement: options.amountCents } },
    })

    return entry.id
  })
}

/** Liga uma automação da fatia 3 — todas nascem desligadas. */
export async function enableAutomation(
  fixture: TenantFixture,
  key: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  await withTenant(fixture.tenantId, (tx) =>
    tx.automation.upsert({
      where: { tenantId_key: { tenantId: fixture.tenantId, key } },
      update: { enabled: true, config },
      create: { tenantId: fixture.tenantId, key, enabled: true, config },
    }),
  )
}

/** Liga o mecanismo de saída. Sem ele o motor recusa todo enfileiramento (RN-13). */
export async function enableMessaging(fixture: TenantFixture): Promise<void> {
  await withTenant(fixture.tenantId, (tx) =>
    tx.messagingSettings.upsert({
      where: { tenantId: fixture.tenantId },
      update: { enabled: true },
      create: { tenantId: fixture.tenantId, enabled: true },
    }),
  )
}

/** Liga o Taxi Dog. Sem isto as automações de corrida somem da listagem (AC-04). */
export async function enableTaxi(fixture: TenantFixture): Promise<void> {
  await withTenant(fixture.tenantId, (tx) =>
    tx.taxiSettings.upsert({
      where: { tenantId: fixture.tenantId },
      update: { enabled: true },
      create: { tenantId: fixture.tenantId, enabled: true },
    }),
  )
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
