import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import {
  PERMISSION_KEYS,
  ROLE_PERMISSIONS,
  type PermissionKey,
  type RoleKey,
} from '@petshop/shared-types'

/**
 * Harness dos testes de integração do financeiro.
 *
 * Sobe o app de verdade — hooks, handler de erro, RLS, e sobretudo as **constraints**:
 * o `chk_credits_bounds`, o trigger de imutabilidade e o índice único de idempotência
 * são metade das garantias deste módulo, e testá-los contra um dublê provaria nada.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_billing_ledger'

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
 * Tutor no banco.
 *
 * O financeiro lê tutores mas não os cria — quem cadastra é o tutor-service, e
 * chamá-lo daqui acoplaria as suítes. O que importa aqui é a linha existir no tenant
 * certo, porque `openAccount` recusa tutor inexistente.
 */
export async function givenTutor(fixture: TenantFixture, fullName = 'Maria Silva'): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        personType: 'PF',
        fullName,
        phoneEncrypted: 'v1:teste',
        phoneHash: randomUUID(),
        status: 'ACTIVE',
      },
    })
    return tutor.id
  })
}

/** Pet vinculado a um tutor — necessário para pacote com `petId`. */
export async function givenPet(
  fixture: TenantFixture,
  tutorId: string,
  name = 'Thor',
): Promise<string> {
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
    await tx.petTutor.create({
      data: { tenantId: fixture.tenantId, petId: pet.id, tutorId, role: 'PRIMARY' },
    })
    return pet.id
  })
}

/** Serviço do catálogo da agenda — o pacote casa por `service_id` (RN-10). */
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

/** Pacote no catálogo do tenant. */
export async function givenPackage(
  fixture: TenantFixture,
  options: {
    name?: string
    serviceIds: string[]
    credits?: number
    priceCents?: number
    validityDays?: number
  },
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const pkg = await tx.servicePackage.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? '4 Banhos Porte Médio',
        serviceIds: options.serviceIds,
        credits: options.credits ?? 4,
        priceCents: BigInt(options.priceCents ?? 32000),
        validityDays: options.validityDays ?? 90,
      },
    })
    return pkg.id
  })
}

/** O saldo materializado, lido direto do banco — é o número que a suíte confere. */
export async function balanceOf(fixture: TenantFixture, tutorId: string): Promise<number> {
  return withTenant(fixture.tenantId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId },
      select: { balanceCents: true },
    })
    return Number(account?.balanceCents ?? 0)
  })
}

/**
 * Lançamentos da conta, do mais antigo ao mais novo — a ordem em que nasceram.
 *
 * O retorno é declarado, e não inferido do Prisma: sem a anotação o `tsc` do `build`
 * recusa emitir (TS2742, "cannot be named without a reference to node_modules"). O
 * `typecheck` passa mesmo assim, porque não emite — então este erro só aparece no
 * build, e é onde ele foi pego.
 */
export interface EntryRow {
  id: string
  direction: 'DEBIT' | 'CREDIT'
  amountCents: bigint
  signedAmountCents: bigint | null
  balanceAfterCents: bigint
  settledCents: bigint
  category: string
  description: string
  sourceType: string
  sourceId: string | null
  status: string
  reversedByEntryId: string | null
  reversesEntryId: string | null
}

export async function entriesOf(fixture: TenantFixture, tutorId: string): Promise<EntryRow[]> {
  return withTenant(fixture.tenantId, (tx) =>
    tx.ledgerEntry.findMany({
      where: { tutorId },
      select: {
        id: true,
        direction: true,
        amountCents: true,
        signedAmountCents: true,
        balanceAfterCents: true,
        settledCents: true,
        category: true,
        description: true,
        sourceType: true,
        sourceId: true,
        status: true,
        reversedByEntryId: true,
        reversesEntryId: true,
      },
      orderBy: [{ postedAt: 'asc' }, { createdAt: 'asc' }],
    }),
  )
}

export function actorOf(fixture: TenantFixture) {
  return { tenantId: fixture.tenantId, actorUserId: fixture.userId }
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

/**
 * Recepção com as permissões **reais** do papel, não uma lista filtrada à mão.
 *
 * Aqui isso importa mais que na agenda: metade dos cortes do §9 é exatamente o que
 * separa recepção de gestor no financeiro (`finance:refund`, `finance:credit`,
 * `finance:configure`), e derivar do catálogo garante que o teste continue verdadeiro
 * quando a matriz de papéis mudar.
 */
export function asReceptionist(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'RECEPTIONIST' as const,
    permissions: [...ROLE_PERMISSIONS.RECEPTIONIST],
  }
}
