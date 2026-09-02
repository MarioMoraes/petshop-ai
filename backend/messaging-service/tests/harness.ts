import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import { PERMISSION_KEYS, type PermissionKey, type RoleKey } from '@petshop/shared-types'

/**
 * Harness dos testes do relacionamento.
 *
 * Sobe o app de verdade e não substitui nada do banco: é o índice único
 * `idx_messages_dedupe` que prova a idempotência do AC-04, e o trigger append-only de
 * `message_events` que prova a imutabilidade da trilha de entrega. O que **é**
 * substituído é o provedor — um dublê de `ChannelPort` grava o que teria saído, e é
 * assim que se testa envio sem mandar e-mail para ninguém.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_messaging'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

// Broker, cache e agendador ficam fora: os testes verificam o efeito no banco, e um
// worker de 30 em 30 segundos rodando durante a suíte é intermitência garantida.
process.env.DISABLE_EVENTS = 'true'
process.env.DISABLE_JOBS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'

// A Evolution é dublada por `installFakeEvolution`, nunca chamada. Estas duas existem
// para que `getEvolutionPort()` não caia no caminho "não configurada" nos testes que
// não instalam dublê — é o mesmo estado de uma instalação com o canal disponível.
process.env.EVOLUTION_API_URL = 'http://evolution.invalido'
process.env.EVOLUTION_API_KEY = 'chave-de-teste'
process.env.EVOLUTION_WEBHOOK_URL = 'http://messaging.invalido/internal/v1/whatsapp/webhook'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { loadEnv, resetEnvCache } = await import('../src/env.js')

/**
 * `loadEnv()` é memoizado, e `lib/logger.ts` o chama **no corpo do módulo**. Um arquivo
 * de teste que importe um módulo do serviço antes deste harness — `dispatch.js`, por
 * exemplo — congela o ambiente antes das linhas acima rodarem, e as variáveis que este
 * arquivo acabou de definir simplesmente não existem.
 *
 * Isso não dá erro: dá um `undefined` a quilômetros da causa. Derrubar o cache aqui é o
 * que torna o harness independente da ordem de importação do teste.
 */
resetEnvCache()
const { clearTenantKeyCache, createTenantKey, encryptForTenant, withTenant } = await import(
  '@petshop/db'
)
const { setEmailPort } = await import('../src/modules/messaging/ports/email.js')
const { setWhatsAppPort } = await import('../src/modules/messaging/ports/whatsapp.js')
const { setEvolutionPort } = await import('../src/modules/messaging/ports/evolution.js')
type EvolutionPort = import('../src/modules/messaging/ports/evolution.js').EvolutionPort

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
  setEmailPort(null)
  setWhatsAppPort(null)
  setEvolutionPort(null)
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
  clearTenantKeyCache()
}

// ─── Dublê de provedor ───────────────────────────────────────────────────────

export interface SentMessage {
  to: string
  subject: string | null
  body: string
}

export interface FakePort {
  sent: SentMessage[]
  /** Faz o próximo envio falhar. `permanent` decide entre retentar e matar. */
  failNext(options?: { permanent?: boolean; errorCode?: string }): void
}

/**
 * Devolve os dois canais ao estado de fábrica.
 *
 * As portas são singleton de módulo — é o que permite injetar um dublê sem passar o
 * provedor por dez assinaturas — e por isso **vazam entre testes**. Chamar isto no
 * `beforeEach` é o que impede um teste que liga o WhatsApp de mudar o canal escolhido
 * pelo teste seguinte, que é exatamente o tipo de falha que se persegue por horas.
 */
export function resetPorts(): void {
  setEmailPort(null)
  setWhatsAppPort(null)
  setEvolutionPort(null)
}

/**
 * Um provedor que guarda o que teria enviado.
 *
 * É o único dublê da suíte, e ele existe porque a alternativa — bater no Resend — não
 * é teste, é envio.
 */
export function installFakeEmailPort(options: { available?: boolean } = {}): FakePort {
  const sent: SentMessage[] = []
  let failure: { permanent?: boolean; errorCode?: string } | null = null

  const available = options.available ?? true

  setEmailPort({
    async isAvailable() {
      return available
    },
    async send(request) {
      if (failure) {
        const current = failure
        failure = null
        return {
          ok: false,
          providerMessageId: null,
          provider: 'fake',
          permanent: current.permanent ?? false,
          errorCode: current.errorCode ?? 'TEST',
          errorDetail: 'falha injetada pelo teste',
        }
      }
      sent.push({ to: request.to, subject: request.subject, body: request.body })
      return { ok: true, providerMessageId: `fake-${sent.length}`, provider: 'fake' }
    },
  })

  return {
    sent,
    failNext(next = {}) {
      failure = next
    },
  }
}

/**
 * Liga o canal WhatsApp com um dublê.
 *
 * `available` é função e não booleano porque a disponibilidade real é **por tenant** —
 * é o que permite um teste ter o petshop A pareado e o B não, no mesmo processo, e
 * exercitar a queda de canal da cascata `AUTO` como ela acontece em produção.
 */
export function installFakeWhatsAppPort(
  options: { available?: boolean | ((tenantId: string) => boolean) } = {},
): FakePort {
  const sent: SentMessage[] = []
  const decide = options.available ?? true
  let failure: { permanent?: boolean; errorCode?: string } | null = null

  setWhatsAppPort({
    async isAvailable(tenantId) {
      return typeof decide === 'function' ? decide(tenantId) : decide
    },
    async send(request) {
      if (failure) {
        const current = failure
        failure = null
        return {
          ok: false,
          providerMessageId: null,
          provider: 'fake-wa',
          permanent: current.permanent ?? false,
          errorCode: current.errorCode ?? 'TEST',
          errorDetail: 'falha injetada pelo teste',
        }
      }
      sent.push({ to: request.to, subject: request.subject, body: request.body })
      return { ok: true, providerMessageId: `wa-${sent.length}`, provider: 'fake-wa' }
    },
  })

  return {
    sent,
    failNext(next = {}) {
      failure = next
    },
  }
}

/** O que um dublê da Evolution registrou, para o teste conferir. */
export interface FakeEvolution {
  created: { instanceName: string; webhookUrl: string; webhookToken: string }[]
  qrRequests: string[]
  sent: { instanceName: string; to: string; text: string }[]
  loggedOut: string[]
  /** Faz o próximo `sendText` falhar. `WHATSAPP_BANNED` derruba a instância (AC-05). */
  failNextSend(errorCode: string, detail?: string): void
  /** O token gerado na criação — é o que o teste manda no webhook. */
  lastToken(): string
}

/**
 * O provedor de WhatsApp, dublado.
 *
 * Ao contrário do `ChannelPort`, este dublê fica **abaixo** do adaptador: o caminho
 * exercitado é o de verdade — a instância no banco, a chave cifrada com a DEK do
 * tenant, o hash do token, a máquina de estados. O que não acontece é o HTTP.
 */
export function installFakeEvolution(): FakeEvolution {
  const created: FakeEvolution['created'] = []
  const qrRequests: string[] = []
  const sent: FakeEvolution['sent'] = []
  const loggedOut: string[] = []
  let nextFailure: { errorCode: string; detail: string } | null = null

  const port: EvolutionPort = {
    configured: true,
    async createInstance(input) {
      created.push(input)
      return { apiKey: `key-${created.length}`, qrCode: 'data:image/png;base64,QVFS' }
    },
    async requestQrCode(instanceName) {
      qrRequests.push(instanceName)
      return 'data:image/png;base64,Tk9WTw=='
    },
    async fetchSession() {
      return { state: 'open', phone: '+5511999990000' }
    },
    async sendText(input) {
      if (nextFailure) {
        const failure = nextFailure
        nextFailure = null
        return {
          ok: false,
          providerMessageId: null,
          permanent: true,
          errorCode: failure.errorCode,
          errorDetail: failure.detail,
        }
      }
      sent.push({ instanceName: input.instanceName, to: input.to, text: input.text })
      return {
        ok: true,
        providerMessageId: `evo-${sent.length}`,
        permanent: false,
        errorCode: null,
        errorDetail: null,
      }
    },
    async logout(instanceName) {
      loggedOut.push(instanceName)
    },
  }

  setEvolutionPort(port)

  return {
    created,
    qrRequests,
    sent,
    loggedOut,
    failNextSend(errorCode, detail = 'falha injetada') {
      nextFailure = { errorCode, detail }
    },
    lastToken() {
      const last = created.at(-1)
      if (!last) throw new Error('nenhuma instância foi criada')
      return last.webhookToken
    },
  }
}

/** O callback da Evolution, como ela o manda: anônimo, com o token no cabeçalho. */
export async function callWebhook(token: string, payload: unknown) {
  const instance = await getApp()
  return instance.inject({
    method: 'POST',
    url: '/internal/v1/whatsapp/webhook',
    headers: { 'x-webhook-token': token },
    payload: payload as object,
  })
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
      settings: {
        create: { timezone: TEST_TIMEZONE, branding: {}, businessHours: {} },
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

/** Liga o motor. Sem isso todo enfileiramento recusa com ERR_CRM_013 (RN-13). */
export async function enableMessaging(
  fixture: TenantFixture,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.messagingSettings.upsert({
      where: { tenantId: fixture.tenantId },
      update: { enabled: true, ...overrides },
      create: { tenantId: fixture.tenantId, enabled: true, ...overrides },
    })
  })
}

export interface TutorOptions {
  email?: string | null
  phone?: string
  /** Consentimento de marketing por canal. Ausente = nenhum registro (AC-03). */
  marketing?: { whatsapp?: boolean; email?: boolean }
}

export async function givenTutor(
  fixture: TenantFixture,
  options: TutorOptions = {},
): Promise<string> {
  const suffix = randomUUID().slice(0, 8)

  return withTenant(fixture.tenantId, async (tx) => {
    const enc = (value: string) => encryptForTenant(tx, fixture.tenantId, value)
    const email = options.email === undefined ? `ana-${suffix}@exemplo.com` : options.email

    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: 'Ana Souza',
        // Cifra de verdade: o motor **decifra** o destinatário antes de enviar, e um
        // placeholder faria o teste exercitar o caminho de erro sem querer.
        phoneEncrypted: await enc(options.phone ?? '+5511987654321'),
        phoneHash: `phone-${suffix}`,
        ...(email
          ? { emailEncrypted: await enc(email), emailHash: `email-${suffix}` }
          : {}),
      },
    })

    for (const [channel, granted] of [
      ['WHATSAPP', options.marketing?.whatsapp],
      ['EMAIL', options.marketing?.email],
    ] as const) {
      if (granted === undefined) continue
      await tx.tutorConsent.create({
        data: {
          tenantId: fixture.tenantId,
          tutorId: tutor.id,
          channel,
          granted,
          purpose: 'MARKETING',
          version: '1.0',
          source: 'STAFF_FORM',
        },
      })
    }

    return tutor.id
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

/** Recepção: lê o histórico, não configura texto nem dispara (§9). */
export function asReceptionist(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'RECEPTIONIST' as const,
    permissions: ['crm:read'] as PermissionKey[],
  }
}

/**
 * Chamada de serviço: sem `userId`, como o crm-automation-service faz. É o que a rota
 * de enfileiramento aceita sem exigir `crm:send`.
 */
export function asService(fixture: TenantFixture) {
  return {
    clerkUserId: 'svc_crm-automation',
    tenantId: fixture.tenantId,
    permissions: [] as PermissionKey[],
  }
}
