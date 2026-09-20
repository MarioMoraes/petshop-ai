import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { callApi, getApp, givenToken, ownerPrisma } from '../harness.js'

/**
 * O segredo do webhook do Clerk (MOD-IDENT-03).
 *
 * Definido **antes** de o app subir, porque `loadEnv` guarda o ambiente em cache. Sem
 * ele a rota recusa tudo com 401 e todo teste dela passaria pelo motivo errado — o
 * mesmo cuidado que o dublê do Resend pede em `tests/messaging/fixtures.ts`.
 */
export const CLERK_WEBHOOK_SECRET = 'whsec_' + Buffer.from('segredo-do-clerk').toString('base64')
process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET

/**
 * O cenário do MOD-IDENT.
 *
 * O núcleo (app, banco, token, `asRole`, `revokePermission`) vem de `../harness.ts`;
 * aqui ficam as duas coisas que só este módulo tem: o dublê do Clerk e o do e-mail.
 *
 * **Os dois são portas, não mocks do próprio código.** O Clerk é a única dependência
 * externa do provisionamento e o Resend a única do convite — trocar as duas mantém os
 * critérios de aceite sendo verificados contra o comportamento real do módulo.
 */

export * from '../harness.js'

import type { SchedulingPort } from '../../src/modules/identity/scheduling-port.js'

const { setClerkPort } = await import('../../src/modules/identity/clerk.js')
const { setMailerPort } = await import('../../src/modules/identity/mailer.js')

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
  /** `org_...:user_...` de quem foi tirado da Organization (MOD-IDENT-05). */
  organizationRemovals: string[]
  createOrganizationCalls: number
}

export const fakeClerk: FakeClerkState = {
  organizations: new Map(),
  users: new Map(),
  permVersions: new Map(),
  organizationMembers: new Set(),
  failCreateOrganization: null,
  failAddOrganizationMembership: null,
  organizationRemovals: [],
  createOrganizationCalls: 0,
}

export function resetFakeClerk(): void {
  fakeClerk.organizations.clear()
  fakeClerk.users.clear()
  fakeClerk.permVersions.clear()
  fakeClerk.organizationMembers.clear()
  fakeClerk.failCreateOrganization = null
  fakeClerk.failAddOrganizationMembership = null
  fakeClerk.organizationRemovals.length = 0
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

  async removeOrganizationMembership({ organizationId, clerkUserId }) {
    fakeClerk.organizationMembers.delete(`${organizationId}:${clerkUserId}`)
    fakeClerk.organizationRemovals.push(`${organizationId}:${clerkUserId}`)
  },

  async setMembershipPermVersion({ organizationId, clerkUserId, permVersion }) {
    fakeClerk.permVersions.set(`${organizationId}:${clerkUserId}`, permVersion)
  },
})

// ─── Dublê do e-mail ─────────────────────────────────────────────────────────

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

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface IdentityTenant {
  /** Quem criou o estabelecimento, e por isso é o `TENANT_ADMIN` dele. */
  clerkUserId: string
  clerkOrgId: string
  tenantId: string
  userId: string
  membershipId: string
  slug: string
}

/**
 * Um estabelecimento criado **pela porta da frente**.
 *
 * Não semeia linha nenhuma: chama `POST /v1/tenants` como o wizard chama. É o que faz
 * o cenário ter Organization no Clerk falso, DEK, configurações padrão e o membership
 * de administrador — tudo o que os outros ACs pressupõem sem dizer.
 *
 * A criação acontece **sem `clerkOrgId`**, que é o estado real de quem ainda não tem
 * estabelecimento nenhum. Só depois disso é que existe org para pôr num token.
 */
export async function givenTenant(slug: string, plan = 'STARTER'): Promise<IdentityTenant> {
  const clerkUserId = givenClerkUser(`${slug}@petshop.test`)
  const created = await callApi({
    method: 'POST',
    url: '/v1/tenants',
    clerkUserId,
    clerkOrgId: null,
    payload: { name: `Petshop ${slug}`, slug, plan, timezone: 'America/Sao_Paulo' },
  })
  const tenantId = created.json().id as string
  const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })
  const membership = await ownerPrisma.membership.findFirstOrThrow({ where: { tenantId } })
  return {
    clerkUserId,
    clerkOrgId: tenant.clerkOrgId as string,
    tenantId,
    userId: membership.userId,
    membershipId: membership.id,
    slug,
  }
}

/** O administrador do estabelecimento — quem o criou. */
export function asAdmin(tenant: IdentityTenant): { clerkUserId: string; clerkOrgId: string } {
  return { clerkUserId: tenant.clerkUserId, clerkOrgId: tenant.clerkOrgId }
}

/**
 * Um segundo membro no estabelecimento, com o papel indicado.
 *
 * Semeia direto, e não pelo convite: o que os testes de papel e de acesso precisam é do
 * vínculo pronto, e atravessar o aceite inteiro os faria depender do MOD-IDENT-06.
 */
export async function givenTeamMember(
  session: IdentityTenant,
  role: string,
  label: string,
): Promise<{ clerkUserId: string; userId: string; membershipId: string }> {
  const clerkUserId = givenClerkUser(`${label}@petshop.test`)
  const { encryptPlatform, hashEmail } = await import('@petshop/db')
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId,
      emailEncrypted: encryptPlatform(`${label}@petshop.test`),
      emailHash: hashEmail(`${label}@petshop.test`),
      fullName: label,
    },
  })
  const membership = await ownerPrisma.membership.create({
    data: { tenantId: session.tenantId, userId: user.id, roleKey: role, status: 'ACTIVE' },
  })
  return { clerkUserId, userId: user.id, membershipId: membership.id }
}

/**
 * Um chamador **sem estabelecimento nenhum**.
 *
 * É o convidado antes de aceitar, e quem vai criar o primeiro tenant. O token existe e
 * é válido; o que falta é a Organization — e é justamente o que as três rotas abertas
 * do módulo esperam encontrar.
 */
export function asStranger(clerkUserId: string): { clerkUserId: string; clerkOrgId: null } {
  return { clerkUserId, clerkOrgId: null }
}

/** Um token de sessão cru, para os testes que precisam montar a chamada à mão. */
export { givenToken }

// ─── O webhook do Clerk (MOD-IDENT-03) ───────────────────────────────────────

/**
 * A entrega do Clerk, assinada como o Svix a assina.
 *
 * O harness **assina de verdade** em vez de dublar a verificação, pelo mesmo motivo do
 * webhook do Resend: a assinatura é a única coisa que protege o endpoint, e um teste que
 * a contornasse não diria nada sobre a recusa do AC-02.
 */
export async function callClerkWebhook(
  payload: unknown,
  options: { secret?: string; timestamp?: number; signature?: string; id?: string } = {},
) {
  const instance = await getApp()
  const raw = JSON.stringify(payload)
  const id = options.id ?? `msg_${randomUUID()}`
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
  const secret = options.secret ?? CLERK_WEBHOOK_SECRET
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signature =
    options.signature ??
    `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64')}`

  return instance.inject({
    method: 'POST',
    url: '/internal/v1/clerk/webhook',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    },
    payload: raw,
  })
}

// ─── Dublê da agenda ─────────────────────────────────────────────────────────

/**
 * A `SchedulingPort` do MOD-IDENT com o resto preenchido.
 *
 * A porta tem quatro métodos — a leitura da RN-07 e as três escritas da RN-06 —, e o
 * teste que quer dublar só a agenda futura não deveria precisar escrever os outros
 * três. O padrão de cada um é o mesmo da porta vazia de produção: ninguém tem
 * agendamento, ninguém tem espelho, não há o que avisar.
 */
export function dubleDaAgenda(parcial: Partial<SchedulingPort>): SchedulingPort {
  return {
    async listFutureProfessionalAppointments() {
      return []
    },
    async mirrorProfessional() {
      return null
    },
    async dropProfessionalMirror() {
      return null
    },
    async announceProfessionalChange() {
      // Sem cache nem broker no teste.
    },
    ...parcial,
  }
}
