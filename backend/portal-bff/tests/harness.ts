import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import { ROLE_PERMISSIONS, type PermissionKey } from '@petshop/shared-types'

/**
 * Harness do Portal do Tutor.
 *
 * Sobe o app de verdade — os dois escopos do Fastify, o handler de erro, o RLS e o
 * banco. O contexto assinado é montado aqui exatamente como o gateway o monta, porque é
 * ele que carrega o `tutorId`: um harness que chamasse os módulos direto não exercitaria
 * a peça nova do MOD-PORTAL-02.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_portal'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

/**
 * Broker e cache ficam fora: os testes verificam o efeito no banco.
 *
 * `DISABLE_REDIS` não desliga o rate limit — troca o contador por um em memória (ver
 * `rate-limit.ts`). É de propósito: assim a suíte exercita a **contagem de verdade**,
 * incluindo o 429 do AC-01 de MOD-PORTAL-11, em vez de um dublê que sempre libera.
 */
process.env.DISABLE_EVENTS = 'true'
process.env.DISABLE_JOBS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { loadEnv } = await import('../src/env.js')
const { setMessagingPort } = await import('../src/modules/portal/messaging-port.js')
const { resetRateMemory } = await import('../src/modules/portal/rate-limit.js')
const { clearTenantKeyCache, createTenantKey, withTenant, encryptWithKey, getTenantKey } =
  await import('@petshop/db')
const { hashTutorEmail, hashTutorPhone } = await import('../src/modules/portal/crypto.js')

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
  setMessagingPort(null)
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
  clearTenantKeyCache()
  resetRateMemory()
}

// ─── Mensageria ──────────────────────────────────────────────────────────────

export interface SentCode {
  tutorId: string
  channel: 'EMAIL' | 'WHATSAPP'
  code: string
}

/**
 * Dublê da porta de mensageria.
 *
 * É por ele que o teste **lê o código**: o valor real nunca sai do processo — a tabela
 * guarda só o hash, e o corpo da mensagem é cifrado com a DEK do tenant. Sem o dublê, o
 * caminho feliz do vínculo não teria como ser exercitado.
 */
export function captureMessages(): { codes: SentCode[]; welcomes: string[] } {
  const codes: SentCode[] = []
  const welcomes: string[] = []

  setMessagingPort({
    async sendAccessCode(request) {
      codes.push({ tutorId: request.tutorId, channel: request.channel, code: request.code })
      return true
    },
    async sendWelcome(request) {
      welcomes.push(request.tutorId)
      return true
    },
  })

  return { codes, welcomes }
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  slug: string
  userId: string
  clerkUserId: string
}

export interface TenantOptions {
  status?: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED'
  portalEnabled?: boolean
}

export async function givenTenant(options: TenantOptions = {}): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const slug = `teste-${suffix}`

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
          branding: { primaryColor: '#2E7D32', logoUrl: 'https://cdn/logo.png' },
          businessHours: {
            monday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
          },
          portalEnabled: options.portalEnabled ?? true,
        },
      },
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Maria Souza',
    },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return { tenantId, slug, userId: user.id, clerkUserId: user.clerkUserId }
}

export interface TutorOptions {
  name?: string
  phone?: string
  email?: string
  portalUserId?: string
  anonymized?: boolean
}

/**
 * Uma ficha de tutor, com os hashes calculados **pelo mesmo caminho do Portal**.
 *
 * Cravar um hash literal aqui esconderia justamente o defeito que este módulo mais
 * teme: o namespace divergente entre quem grava e quem procura.
 */
export async function givenTutor(
  fixture: TenantFixture,
  options: TutorOptions = {},
): Promise<string> {
  const phone = options.phone ?? '+5511987654321'

  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: options.name ?? 'Maria Souza',
        phoneEncrypted: encryptWithKey(phone, key),
        phoneHash: hashTutorPhone(phone),
        ...(options.email
          ? {
              emailEncrypted: encryptWithKey(options.email, key),
              emailHash: hashTutorEmail(options.email),
            }
          : {}),
        ...(options.portalUserId ? { portalUserId: options.portalUserId } : {}),
        ...(options.anonymized ? { anonymizedAt: new Date() } : {}),
      },
      select: { id: true },
    })
    return tutor.id
  })
}

/** Um segundo login do Clerk, para o caso da ficha já vinculada a outra conta. */
export async function givenUser(label: string): Promise<string> {
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${label}_${randomUUID().slice(0, 8)}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${label}-${randomUUID().slice(0, 8)}`,
      fullName: 'Outro Usuário',
    },
    select: { id: true },
  })
  return user.id
}

// ─── Requisições ─────────────────────────────────────────────────────────────

export interface CallerOptions {
  clerkUserId: string
  userId?: string
  tenantId?: string
  tutorId?: string
  permissions?: PermissionKey[]
}

export function authHeaders(options: CallerOptions): Record<string, string> {
  const context: ServiceAuthContext = {
    clerkUserId: options.clerkUserId,
    permissions: options.permissions ?? [],
  }
  if (options.userId) context.userId = options.userId
  if (options.tenantId) context.tenantId = options.tenantId
  if (options.tutorId) {
    context.tutorId = options.tutorId
    context.role = 'TUTOR'
    context.permissions = [...ROLE_PERMISSIONS.TUTOR]
  }

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

/** Quem entrou no Clerk mas ainda não vinculou ficha nenhuma. */
export function asVisitor(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
  }
}

/** Quem já é tutor deste petshop. */
export function asTutor(fixture: TenantFixture, tutorId: string) {
  return { ...asVisitor(fixture), tutorId }
}

// ─── Cenário da fatia 2 — pets, agenda e prontuário ──────────────────────────

/**
 * O catálogo global (`tenant_id IS NULL`) sobrevive ao truncate e é semeado pela
 * migration. Buscá-lo em vez de criá-lo é o que faz o teste exercitar as mesmas linhas
 * que o Admin usa — um porte inventado aqui teria faixa de peso diferente da real.
 */
export interface CatalogFixture {
  speciesDogId: string
  sizeSmallId: string
  breedId: string
  coatId: string | null
}

let catalog: CatalogFixture | null = null

export async function getCatalog(): Promise<CatalogFixture> {
  if (catalog) return catalog

  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'SMALL', tenantId: null } }),
  ])
  const [breed, coat] = await Promise.all([
    ownerPrisma.breed.findFirstOrThrow({ where: { speciesId: species.id, tenantId: null } }),
    ownerPrisma.coat.findFirst({ where: { tenantId: null } }),
  ])

  catalog = {
    speciesDogId: species.id,
    sizeSmallId: size.id,
    breedId: breed.id,
    coatId: coat?.id ?? null,
  }
  return catalog
}

export interface PetOptions {
  name?: string
  status?: 'ACTIVE' | 'INACTIVE' | 'DECEASED' | 'TRANSFERRED_OUT'
  birthDate?: Date
  notes?: string
  /** Vínculo já encerrado — o pet transferido do AC-05. */
  unlinked?: boolean
  weightKg?: number
}

export async function givenPet(
  fixture: TenantFixture,
  tutorId: string,
  options: PetOptions = {},
): Promise<string> {
  const cat = await getCatalog()

  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Thor',
        speciesId: cat.speciesDogId,
        breedId: cat.breedId,
        sizeId: cat.sizeSmallId,
        ...(cat.coatId ? { coatId: cat.coatId } : {}),
        status: options.status ?? 'ACTIVE',
        ...(options.birthDate
          ? { birthDate: options.birthDate, birthDatePrecision: 'EXACT' as const }
          : {}),
        ...(options.notes ? { notesEncrypted: encryptWithKey(options.notes, key) } : {}),
        ...(options.weightKg !== undefined ? { weightKg: options.weightKg } : {}),
        petTutors: {
          create: {
            tenantId: fixture.tenantId,
            tutorId,
            role: 'PRIMARY',
            ...(options.unlinked ? { unlinkedAt: new Date() } : {}),
          },
        },
      },
      select: { id: true },
    })
    return pet.id
  })
}

/** Um serviço de catálogo, que o item do agendamento exige por FK. */
export async function givenService(fixture: TenantFixture, name = 'Banho'): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        category: 'BATH',
        baseDurationMin: 60,
      },
      select: { id: true },
    })
    return service.id
  })
}

export async function givenProfessional(fixture: TenantFixture, name = 'Ana Banhista'): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const professional = await tx.professional.create({
      data: { tenantId: fixture.tenantId, displayName: name, roleKey: 'GROOMER' },
      select: { id: true },
    })
    return professional.id
  })
}

export interface AppointmentOptions {
  startsAt: Date
  status?: 'PENDING' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'
  serviceLabel?: string
}

export async function givenAppointment(
  fixture: TenantFixture,
  tutorId: string,
  petId: string,
  professionalId: string,
  options: AppointmentOptions,
): Promise<string> {
  // Fora do `withTenant` de baixo de propósito: aninhar uma transação dentro da outra
  // trava o pool, e a falha apareceria como timeout sem relação aparente com o teste.
  const serviceId = await givenService(fixture, options.serviceLabel ?? 'Banho')

  return withTenant(fixture.tenantId, async (tx) => {
    const appointment = await tx.appointment.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        professionalId,
        startsAt: options.startsAt,
        endsAt: new Date(options.startsAt.getTime() + 60 * 60 * 1000),
        status: options.status ?? 'CONFIRMED',
        source: 'STAFF',
        totalCents: 8000n,
        items: {
          create: {
            tenantId: fixture.tenantId,
            serviceId,
            label: options.serviceLabel ?? 'Banho',
            durationMin: 60,
            priceCents: 8000n,
          },
        },
      },
      select: { id: true },
    })
    return appointment.id
  })
}

export interface AttendanceOptions {
  startedAt: Date
  status?: 'DRAFT' | 'COMPLETED' | 'VOIDED'
  serviceLabel?: string
  /** Cada nota vira uma linha; a visibilidade é o que o AC-02 exercita. */
  notes?: { body: string; visibility: 'INTERNAL' | 'TUTOR_VISIBLE' }[]
  voided?: boolean
}

export async function givenAttendance(
  fixture: TenantFixture,
  tutorId: string,
  petId: string,
  professionalId: string,
  options: AttendanceOptions,
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const attendance = await tx.attendance.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        type: 'BATH',
        origin: 'SCHEDULED',
        performedBy: professionalId,
        startedAt: options.startedAt,
        finishedAt: new Date(options.startedAt.getTime() + 60 * 60 * 1000),
        status: options.status ?? 'COMPLETED',
        ...(options.voided
          ? { voidReason: 'Lançado no pet errado', voidedAt: new Date(), status: 'VOIDED' as const }
          : {}),
        items: {
          create: {
            tenantId: fixture.tenantId,
            serviceId: randomUUID(),
            label: options.serviceLabel ?? 'Banho',
            executedBy: professionalId,
            unitPriceCents: 8000n,
            totalPriceCents: 8000n,
          },
        },
        ...(options.notes?.length
          ? {
              notes: {
                create: options.notes.map((note) => ({
                  tenantId: fixture.tenantId,
                  kind: 'OPERATIONAL' as const,
                  visibility: note.visibility,
                  bodyEncrypted: encryptWithKey(note.body, key),
                })),
              },
            }
          : {}),
      },
      select: { id: true },
    })
    return attendance.id
  })
}

export async function givenAllergy(
  fixture: TenantFixture,
  petId: string,
  label = 'Aveia',
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.allergy.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        type: 'FOOD',
        label,
        severity: 'HIGH',
      },
    })
  })
}

export async function givenTemperament(fixture: TenantFixture, petId: string): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.temperament.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        classification: 'REACTIVE',
        contexts: ['STRANGERS'],
      },
    })
  })
}
