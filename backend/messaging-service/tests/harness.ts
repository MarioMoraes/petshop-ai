import { createHmac, randomUUID } from 'node:crypto'
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

// Sem segredo o webhook do Resend recusa **tudo** (AC-03), e todo teste dele passaria
// pelo motivo errado. O valor é o mesmo que `callEmailWebhook` usa para assinar.
process.env.RESEND_WEBHOOK_SECRET =
  'whsec_' + Buffer.from('segredo-de-teste').toString('base64')

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
const { clearTenantKeyCache, createTenantKey, encryptForTenant, encryptPlatform, withTenant } =
  await import('@petshop/db')
const { setEmailPort } = await import('../src/modules/messaging/ports/email.js')
const { setStoragePort } = await import('../src/lib/storage.js')
const { setWhatsAppPort } = await import('../src/modules/messaging/ports/whatsapp.js')
const { setEvolutionPort, EvolutionRequestError } = await import(
  '../src/modules/messaging/ports/evolution.js'
)
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
  /** O nome do arquivo que viajou anexo, ou `null` quando foi só texto/link. */
  attachment: string | null
  /** O molde de marca, ou `null` quando o texto é do petshop (MOD-NOTIF-04). */
  html: string | null
  /** Como o remetente foi montado (MOD-NOTIF-03). */
  senderName: string | null
  replyTo: string | null
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
  setStoragePort(null)
}

/**
 * O bucket dos documentos, dublado em memória.
 *
 * Só `read` faz alguma coisa: este serviço **não escreve** documento nenhum, e um dublê
 * com `put` funcional daria a impressão contrária. Quem arquiva é o serviço de domínio
 * que emitiu o papel.
 */
export function installFakeDocumentStorage(): Map<string, Buffer> {
  const objects = new Map<string, Buffer>()
  setStoragePort({
    async put(key, body) {
      objects.set(key, body)
    },
    async signedUrl(key) {
      return `https://r2.test/${key}?assinada=1`
    },
    async read(key) {
      const stored = objects.get(key)
      if (!stored) throw new Error(`objeto inexistente: ${key}`)
      return stored
    },
  })
  return objects
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
      sent.push({
        to: request.to,
        subject: request.subject,
        body: request.body,
        attachment: request.attachment?.filename ?? null,
        html: request.html ?? null,
        senderName: request.senderName,
        replyTo: request.replyTo,
      })
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
      sent.push({
        to: request.to,
        subject: request.subject,
        body: request.body,
        attachment: request.attachment?.filename ?? null,
        html: request.html ?? null,
        senderName: request.senderName,
        replyTo: request.replyTo,
      })
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
  /** Instâncias apagadas no provedor — a identidade vai junto, e é o ponto. */
  deleted: string[]
  /** Faz o próximo `sendText` falhar. `WHATSAPP_BANNED` derruba a instância (AC-05). */
  failNextSend(errorCode: string, detail?: string): void
  /** Faz a próxima criação de instância falhar, como um provedor fora do ar. */
  failNextCreate(detail?: string): void
  /**
   * Roda **dentro** do `createInstance`, antes de ele responder.
   *
   * Existe para afirmar o que só se vê nesse instante: que a linha do tenant já está
   * no banco quando o provedor passa a existir. A Evolution dispara o primeiro
   * `qrcode.updated` em menos de um segundo, e se a linha vier depois esse callback
   * chega sem dono e leva 401 — que ela trata como definitivo.
   */
  onCreateInstance(hook: (input: { webhookToken: string }) => Promise<void>): void
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
  const deleted: string[] = []
  let nextFailure: { errorCode: string; detail: string } | null = null
  let nextCreateFailure: string | null = null
  let createHook: ((input: { webhookToken: string }) => Promise<void>) | null = null

  const port: EvolutionPort = {
    configured: true,
    async createInstance(input) {
      if (createHook) await createHook(input)
      if (nextCreateFailure) {
        const detail = nextCreateFailure
        nextCreateFailure = null
        // O erro precisa ser o do adaptador, e não um `Error` cru: é a classe que faz
        // a rota responder 502 em vez de 500, e um dublê que lança outra coisa testa
        // um caminho que a Evolution nunca percorre.
        throw new EvolutionRequestError(503, detail)
      }
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
    async deleteInstance(instanceName) {
      deleted.push(instanceName)
    },
  }

  setEvolutionPort(port)

  return {
    created,
    qrRequests,
    sent,
    loggedOut,
    deleted,
    failNextSend(errorCode, detail = 'falha injetada') {
      nextFailure = { errorCode, detail }
    },
    failNextCreate(detail = 'provedor fora do ar') {
      nextCreateFailure = detail
    },
    onCreateInstance(hook) {
      createHook = hook
    },
    lastToken() {
      const last = created.at(-1)
      if (!last) throw new Error('nenhuma instância foi criada')
      return last.webhookToken
    },
  }
}

/**
 * Um documento arquivado, como o MOD-DOC o deixa (MOD-NOTIF-05).
 *
 * `bytes` grava o arquivo no dublê de storage e `sizeBytes` sai do que foi gravado —
 * não de um número escolhido à mão. É o que permite o teste do teto exercitar a mesma
 * comparação que a produção faz.
 */
export async function givenDocument(
  fixture: TenantFixture,
  options: {
    tutorId?: string
    kind?: 'RECEIPT' | 'PRESCRIPTION' | 'TERM_ACCEPTANCE' | 'IMAGE_CONSENT'
    status?: 'PENDING' | 'ISSUED' | 'CANCELLED' | 'FAILED'
    bytes?: Buffer
    /** Sobrescreve o tamanho gravado, para exercitar o teto sem alocar 8 MB. */
    sizeBytes?: number
    storage?: Map<string, Buffer>
  } = {},
): Promise<string> {
  const kind = options.kind ?? 'RECEIPT'
  const status = options.status ?? 'ISSUED'
  const bytes = options.bytes ?? Buffer.from('%PDF-1.7 documento de teste')

  return withTenant(fixture.tenantId, async (tx) => {
    const document = await tx.document.create({
      data: {
        tenantId: fixture.tenantId,
        kind,
        number: `${kind === 'RECEIPT' ? '' : 'RX-'}2026/${String(Math.floor(Math.random() * 899999) + 100000)}`,
        ...(options.tutorId ? { tutorId: options.tutorId } : {}),
        status,
        ...(status === 'PENDING'
          ? {}
          : {
              storageKey: `tenants/${fixture.tenantId}/documents/temp.pdf`,
              sizeBytes: options.sizeBytes ?? bytes.byteLength,
              issuedAt: new Date(),
            }),
      },
    })

    if (status !== 'PENDING') {
      const key = `tenants/${fixture.tenantId}/documents/${document.id}.pdf`
      await tx.document.update({ where: { id: document.id }, data: { storageKey: key } })
      options.storage?.set(key, bytes)
    }

    return document.id
  })
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

/**
 * O callback do Resend, assinado como o Svix o assina.
 *
 * O harness assina de verdade em vez de dublar a verificação, porque é justamente a
 * assinatura que protege o endpoint: um teste que a contornasse não diria nada sobre o
 * AC-03, que é o critério mais importante da sub-feature.
 */
export const RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('segredo-de-teste').toString('base64')

export async function callEmailWebhook(
  payload: unknown,
  options: { secret?: string; timestamp?: number; signature?: string } = {},
) {
  const instance = await getApp()
  const raw = JSON.stringify(payload)
  const id = `msg_${randomUUID()}`
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
  const secret = options.secret ?? RESEND_WEBHOOK_SECRET
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signature =
    options.signature ??
    `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64')}`

  return instance.inject({
    method: 'POST',
    url: '/internal/v1/email/webhook',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    },
    payload: raw,
  })
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
  /** O endereço do membro da equipe, em claro — para o teste conferir o que saiu. */
  userEmail: string
}

export const TEST_TIMEZONE = 'America/Sao_Paulo'

/**
 * A identidade visual e o endereço do estabelecimento (MOD-NOTIF-04).
 *
 * Sai de `tenant_settings`, e é a **mesma** linha que o cabeçalho do PDF lê: um teste
 * que montasse o molde de outra fonte não provaria que o recibo impresso e o e-mail que
 * o carrega dizem o mesmo endereço.
 */
export async function givenBranding(
  fixture: TenantFixture,
  options: { logoUrl?: string; primaryColor?: string; address?: boolean } = {},
): Promise<void> {
  await withTenant(fixture.tenantId, (tx) =>
    tx.tenantSettings.update({
      where: { tenantId: fixture.tenantId },
      data: {
        branding: {
          ...(options.logoUrl ? { logoUrl: options.logoUrl } : {}),
          primaryColor: options.primaryColor ?? '#1B7F5A',
        },
        publicPhone: '(11) 4002-8922',
        ...(options.address === false
          ? {}
          : {
              addressZip: '01310100',
              addressStreet: 'Avenida Paulista',
              addressNumber: '1000',
              addressDistrict: 'Bela Vista',
              addressCity: 'São Paulo',
              addressState: 'SP',
            }),
      },
    }),
  )
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
        create: { timezone: TEST_TIMEZONE, branding: {}, businessHours: {} },
      },
    },
  })

  // O e-mail é cifrado **com a chave de plataforma**, e não com a DEK do tenant: é a
  // pegadinha central do MOD-NOTIF-01, e um placeholder aqui faria todo teste de
  // destinatário de equipe exercitar o caminho de erro sem querer.
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: encryptPlatform(`equipe-${suffix}@exemplo.com`),
      emailHash: `hash-${suffix}`,
      fullName: 'Atendente de Teste',
    },
  })

  await ownerPrisma.membership.create({
    data: { tenantId, userId: user.id, roleKey: 'TENANT_ADMIN' },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return {
    tenantId,
    userId: user.id,
    clerkUserId: user.clerkUserId,
    userEmail: `equipe-${suffix}@exemplo.com`,
  }
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
