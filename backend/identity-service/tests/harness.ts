import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import type { PermissionKey, RoleKey } from '@petshop/shared-types'

/**
 * Harness dos testes de integração.
 *
 * Sobe o app de verdade — hooks, handler de erro, RLS, banco — e substitui só o
 * Clerk, que é a única dependência externa. Isso mantém os ACs sendo verificados
 * contra o comportamento real do sistema, não contra dublês do próprio código.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
// Banco de testes próprio deste pacote: o turbo roda as suítes em paralelo.
process.env.TEST_DATABASE_NAME = 'petshop_test_identity'

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
process.env.CLERK_SECRET_KEY ||= 'sk_test_harness'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { setClerkPort } = await import('../src/lib/clerk.js')
const { loadEnv } = await import('../src/env.js')

// ─── Dublê do Clerk ──────────────────────────────────────────────────────────

export interface FakeClerkState {
  organizations: Map<string, { id: string; slug: string; name: string }>
  users: Map<string, { id: string; email: string; fullName: string }>
  permVersions: Map<string, number>
  /** `org_...:user_...` de quem entrou na Organization — o aceite de MOD-IDENT-06. */
  organizationMembers: Set<string>
  /** Quando definido, `createOrganization` estoura — simula o timeout do AC-03. */
  failCreateOrganization: Error | null
  /** Quando definido, `addOrganizationMembership` estoura: o aceite pela metade. */
  failAddOrganizationMembership: Error | null
  createOrganizationCalls: number
}

export const fakeClerk: FakeClerkState = {
  organizations: new Map(),
  users: new Map(),
  permVersions: new Map(),
  organizationMembers: new Set(),
  failCreateOrganization: null,
  failAddOrganizationMembership: null,
  createOrganizationCalls: 0,
}

export function resetFakeClerk(): void {
  fakeClerk.organizations.clear()
  fakeClerk.users.clear()
  fakeClerk.permVersions.clear()
  fakeClerk.organizationMembers.clear()
  fakeClerk.failCreateOrganization = null
  fakeClerk.failAddOrganizationMembership = null
  fakeClerk.createOrganizationCalls = 0
}

/** Registra um usuário no Clerk falso e devolve o `clerkUserId`. */
export function givenClerkUser(email: string, fullName = 'João da Silva'): string {
  const id = `user_${randomBytes(8).toString('hex')}`
  fakeClerk.users.set(id, { id, email, fullName })
  return id
}

setClerkPort({
  async createOrganization({ name, slug }) {
    fakeClerk.createOrganizationCalls += 1
    if (fakeClerk.failCreateOrganization) throw fakeClerk.failCreateOrganization
    const org = { id: `org_${randomBytes(8).toString('hex')}`, slug, name }
    fakeClerk.organizations.set(slug, org)
    return org
  },

  async findOrganizationBySlug(slug) {
    if (fakeClerk.failCreateOrganization) throw fakeClerk.failCreateOrganization
    return fakeClerk.organizations.get(slug) ?? null
  },

  async getUser(clerkUserId) {
    const user = fakeClerk.users.get(clerkUserId)
    if (!user) throw new Error(`Usuário ${clerkUserId} não existe no Clerk`)
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: null,
      mfaEnabled: false,
    }
  },

  async addOrganizationMembership({ organizationId, clerkUserId }) {
    if (fakeClerk.failAddOrganizationMembership) throw fakeClerk.failAddOrganizationMembership
    fakeClerk.organizationMembers.add(`${organizationId}:${clerkUserId}`)
  },

  async setMembershipPermVersion({ organizationId, clerkUserId, permVersion }) {
    fakeClerk.permVersions.set(`${organizationId}:${clerkUserId}`, permVersion)
  },
})

// ─── Dublê do e-mail ─────────────────────────────────────────────────────────

const { setMailerPort } = await import('../src/lib/mailer.js')

export interface SentMail {
  to: string
  tenantName: string
  roleLabel: string
  inviteUrl: string
  invitedByName: string | null
}

/** O que teria saído por e-mail. A suíte nunca fala com provedor nenhum. */
export const sentMails: SentMail[] = []

/** Quando `true`, o envio falha — o convite tem que sobreviver a isso. */
export const mailerState = { failing: false }

export function resetMailer(): void {
  sentMails.length = 0
  mailerState.failing = false
}

setMailerPort({
  async sendInvitation(mail) {
    if (mailerState.failing) return false
    sentMails.push({
      to: mail.to,
      tenantName: mail.tenantName,
      roleLabel: mail.roleLabel,
      inviteUrl: mail.inviteUrl,
      invitedByName: mail.invitedByName,
    })
    return true
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

/**
 * Monta os headers assinados que o gateway produziria. Os testes exercitam o
 * serviço pelo mesmo contrato que o gateway usa em produção.
 */
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
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
