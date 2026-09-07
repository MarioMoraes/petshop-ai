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
 * Sobe o app de verdade — hooks, handler de erro, RLS, índices, banco — e não
 * substitui nada: o medical-record-service não tem dependência externa a dublar. É
 * o índice único parcial de `temperaments` que prova o RN-15, não um mock.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_record'

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
 * Cria tenant, usuário e DEK — o mínimo para o pet-service funcionar. Usa o cliente
 * owner porque montar cenário não é o que está sob teste; a partir daí, tudo passa
 * pela API com RLS ativo.
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

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId }
}

/**
 * Pet criado direto no banco, com espécie e porte do catálogo global.
 *
 * O medical-record-service lê pets mas não os cria — quem cadastra é o pet-service,
 * e chamá-lo daqui acoplaria as duas suítes. O que importa para o prontuário é a
 * linha existir no tenant certo.
 */
export async function givenPet(fixture: TenantFixture, name = 'Thor'): Promise<string> {
  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
  ])

  return withTenant(fixture.tenantId, async (tx) => {
    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        speciesId: species.id,
        sizeId: size.id,
        status: 'ACTIVE',
      },
    })
    return pet.id
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
  /** Usado pelo upload: o `content-type` carrega o `boundary` do multipart. */
  headers?: Record<string, string>
}

export async function callApi(options: InjectOptions) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    headers: { ...authHeaders(options), ...(options.headers ?? {}) },
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

// ─── Cenário do atendimento (MOD-PRONT-01/02/09/10) ──────────────────────────

/**
 * O atendimento não nasce de um POST — nasce do check-out da agenda. Testá-lo exige
 * então o cenário inteiro do outro lado: tutor, pet vinculado, profissional, serviço
 * com preço e agendamento. Tudo criado direto no banco, pelo mesmo motivo de
 * `givenPet`: chamar o scheduling-service daqui acoplaria as duas suítes.
 */
export async function givenTutor(fixture: TenantFixture, name = 'Ana Souza'): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: name,
        phoneEncrypted: 'v1:x:x:x',
        phoneHash: `phone-${suffix}`,
      },
    })
    return tutor.id
  })
}

export async function linkTutor(
  fixture: TenantFixture,
  petId: string,
  tutorId: string,
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.petTutor.create({
      data: { tenantId: fixture.tenantId, petId, tutorId, role: 'PRIMARY' },
    })
  })
}

export async function givenProfessional(
  fixture: TenantFixture,
  userId?: string,
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const professional = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: 'Bruna Tosadora',
        roleKey: 'GROOMER',
        ...(userId ? { userId } : {}),
      },
    })
    return professional.id
  })
}

/**
 * O veterinário que assina o receituário (MOD-DOC-04).
 *
 * O `userId` é o que amarra o profissional ao usuário autenticado: quem prescreve é
 * quem está logado, e não o `performed_by` do atendimento. Sem esse vínculo, o serviço
 * recusa com `ERR_PRONT_009` — que é justamente o comportamento sob teste.
 */
export async function givenVet(
  fixture: TenantFixture,
  options: { userId?: string; crmv?: string | null; crmvState?: string | null } = {},
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const vet = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: 'Dra. Helena Prado',
        roleKey: 'VET',
        userId: options.userId ?? fixture.userId,
        crmv: options.crmv === undefined ? '12345' : options.crmv,
        crmvState: options.crmvState === undefined ? 'SP' : options.crmvState,
      },
    })
    return vet.id
  })
}

/**
 * O cadastro do estabelecimento, sem o qual nenhum documento formal sai.
 *
 * Tenants criados antes de 2026-08-28 estão sem endereço, e o AC-02 de MOD-DOC-01 manda
 * recusar a emissão dizendo qual dado falta. O `givenTenant` não cria estas linhas de
 * propósito: é o cenário de quem nunca preencheu.
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

export async function givenService(fixture: TenantFixture, name = 'Banho'): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        category: 'BATH',
        baseDurationMin: 60,
      },
    })
    return service.id
  })
}

export interface AppointmentFixture {
  appointmentId: string
  petId: string
  tutorId: string
  professionalId: string
  serviceId: string
}

export async function givenAppointment(
  fixture: TenantFixture,
  options: { status?: 'CHECKED_IN' | 'COMPLETED'; professionalUserId?: string } = {},
): Promise<AppointmentFixture> {
  const petId = await givenPet(fixture)
  const tutorId = await givenTutor(fixture)
  await linkTutor(fixture, petId, tutorId)
  const professionalId = await givenProfessional(fixture, options.professionalUserId)
  const serviceId = await givenService(fixture)

  const startsAt = new Date(Date.now() - 3_600_000)

  const appointmentId = await withTenant(fixture.tenantId, async (tx) => {
    const appointment = await tx.appointment.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        professionalId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        status: options.status ?? 'CHECKED_IN',
        totalCents: BigInt(8000),
        checkinAt: startsAt,
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

  return { appointmentId, petId, tutorId, professionalId, serviceId }
}

/** O payload que o check-out da agenda publica — a porta de entrada do módulo. */
export function checkoutEvent(
  fixture: TenantFixture,
  appointment: AppointmentFixture,
  overrides: Record<string, unknown> = {},
) {
  return {
    tenantId: fixture.tenantId,
    appointmentId: appointment.appointmentId,
    petId: appointment.petId,
    tutorId: appointment.tutorId,
    professionalId: appointment.professionalId,
    items: [{ serviceId: appointment.serviceId, label: 'Banho', priceCents: 8000 }],
    totalCents: 8000,
    weightKg: 12.5,
    origin: 'SCHEDULED',
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  }
}
