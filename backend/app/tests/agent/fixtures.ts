import { createHash, randomUUID } from 'node:crypto'
import type { AgentTone } from '@petshop/shared-types'
import { asRole, callApi, getApp, ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-AI (PRD agentes_ia_15).
 *
 * As fixtures ficam por módulo porque os nomes colidem: todo módulo tem um `givenTenant`
 * com as configurações que **ele** precisa. O núcleo (`../harness.js`) é reexportado
 * daqui, então o teste importa de um lugar só.
 *
 * A diferença para as do MOD-NOTIF é uma linha, e é a que faz o módulo existir: aqui o
 * `phoneHash` do tutor é o **hash de verdade** do telefone, e não um placeholder. A
 * resolução do número que escreveu é o primeiro passo de toda mensagem recebida — um
 * hash inventado faria toda ficha parecer desconhecida, e a suíte inteira exercitaria o
 * caminho do AC-02 sem querer.
 */

export * from '../harness.js'

process.env.EVOLUTION_API_URL = 'http://evolution.invalido'
process.env.EVOLUTION_API_KEY = 'chave-de-teste'
process.env.EVOLUTION_WEBHOOK_URL = 'http://app.invalido/internal/v1/whatsapp/webhook'

const { createTenantKey, encryptForTenant, hashSearchable, withTenant } =
  await import('@petshop/db')
const { TUTOR_PHONE_HASH_NAMESPACE } = await import('@petshop/shared-types')
const { setAgentMessagingPort } = await import('../../src/modules/agent/messaging-port.js')
const { setAgentInboundPort } = await import('../../src/modules/messaging/ports/agent.js')
const { handleInbound } = await import('../../src/modules/agent/conversations.js')

export const TEST_TIMEZONE = 'America/Sao_Paulo'

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
  clerkOrgId: string
}

export function hashPhone(phoneE164: string): string {
  return hashSearchable(TUTOR_PHONE_HASH_NAMESPACE, phoneE164)
}

export async function givenTenant(name = 'Petshop Teste'): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const clerkOrgId = `org_${suffix}`

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug: `teste-${suffix}`,
      name,
      clerkOrgId,
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
      emailEncrypted: `equipe-${suffix}@exemplo.com`,
      emailHash: `hash-${suffix}`,
      fullName: 'Atendente de Teste',
    },
  })

  await ownerPrisma.membership.create({
    data: {
      tenantId,
      userId: user.id,
      roleKey: 'TENANT_ADMIN',
      status: 'ACTIVE',
      mfaGraceUntil: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

/** Uma ficha com o telefone **hasheado de verdade** — ver o cabeçalho deste arquivo. */
export async function givenTutor(
  fixture: TenantFixture,
  options: { phone?: string; name?: string } = {},
): Promise<string> {
  const phone = options.phone ?? '+5511987654321'

  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: options.name ?? 'Ana Souza',
        phoneEncrypted: await encryptForTenant(tx, fixture.tenantId, phone),
        phoneHash: hashPhone(phone),
      },
      select: { id: true },
    })
    return tutor.id
  })
}

/** Liga o motor de mensagens. Sem isso a resposta da recepção recusa com ERR_CRM_013. */
export async function enableMessaging(fixture: TenantFixture): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.messagingSettings.upsert({
      where: { tenantId: fixture.tenantId },
      update: { enabled: true },
      create: { tenantId: fixture.tenantId, enabled: true },
    })
  })
}

/**
 * Liga a porta que o `registerAgentModule` liga em produção.
 *
 * O app do harness monta os módulos de verdade, então ela **já está ligada** — esta
 * função existe para o teste que a desliga poder devolvê-la, e para deixar visível no
 * arquivo de teste qual é a ligação que faz a mensagem virar conversa.
 */
export function installAgentPort(): void {
  setAgentInboundPort({ onInbound: handleInbound })
}

export interface SentReply {
  tutorId: string
  conversationId: string
  text: string
}

/**
 * O motor do MOD-NOTIF, dublado.
 *
 * A alternativa seria enfileirar de verdade e conferir a linha em `messages` — o que a
 * suíte do MOD-NOTIF já faz, com muito mais cuidado do que caberia aqui. O que este
 * módulo precisa provar é que a resposta **passa pelo motor** e que o turno só nasce
 * depois de ele aceitar.
 */
export function installFakeMessaging(): { sent: SentReply[]; failNext(): void } {
  const sent: SentReply[] = []
  let fail = false

  setAgentMessagingPort({
    async sendReply(request) {
      if (fail) {
        fail = false
        throw new Error('falha injetada pelo teste')
      }
      sent.push({
        tutorId: request.tutorId,
        conversationId: request.conversationId,
        text: request.text,
      })
      return randomUUID()
    },
  })

  return {
    sent,
    failNext() {
      fail = true
    },
  }
}

export function resetPorts(): void {
  setAgentMessagingPort(null)
  setModelPort(null)
  setAgentPortalPort(null)
  setTurnScheduler(null)
  installAgentPort()
}

/**
 * O canal pareado, com um token de webhook conhecido.
 *
 * Escreve a linha direto em vez de percorrer o pareamento pela tela: o que este módulo
 * exercita começa **depois** de a instância existir, e a máquina de estados do
 * pareamento já é coberta pela suíte do MOD-CRM-01.
 */
export async function givenWhatsapp(fixture: TenantFixture): Promise<string> {
  const token = `webhook-${randomUUID()}`
  await withTenant(fixture.tenantId, (tx) =>
    tx.whatsappInstance.create({
      data: {
        tenantId: fixture.tenantId,
        instanceName: `tenant-teste-${fixture.tenantId.slice(0, 8)}`,
        status: 'CONNECTED',
        phoneE164: '+5511999990000',
        webhookTokenHash: createHash('sha256').update(token).digest('hex'),
        connectedAt: new Date(),
      },
    }),
  )
  return token
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
 * Uma mensagem recebida, no formato da Evolution.
 *
 * O teste manda o payload **cru** de propósito: o que o módulo promete é entender o que o
 * provedor entrega, e um helper que já devolvesse o formato interno pularia justamente a
 * tradução que `inbound.ts` existe para fazer.
 */
export function upsertPayload(options: {
  phone?: string
  text?: string
  id?: string
  fromMe?: boolean
  jid?: string
  messageType?: string
  message?: Record<string, unknown>
}): unknown {
  const phone = (options.phone ?? '+5511987654321').replace(/\D/g, '')
  return {
    event: 'messages.upsert',
    instance: 'tenant-teste',
    data: {
      key: {
        remoteJid: options.jid ?? `${phone}@s.whatsapp.net`,
        fromMe: options.fromMe ?? false,
        id: options.id ?? `evo-${randomUUID()}`,
      },
      pushName: 'Ana',
      messageType: options.messageType ?? 'conversation',
      message: options.message ?? { conversation: options.text ?? 'oi, que horas é o banho?' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  }
}

export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/** Recepção: o papel que atende a fila (§9). */
export async function asReceptionist(fixture: TenantFixture): Promise<Caller> {
  return asRole(fixture, 'RECEPTIONIST')
}

export async function callAsStaff(
  fixture: TenantFixture,
  options: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    url: string
    payload?: unknown
  },
) {
  return callApi({ ...asAdmin(fixture), ...options })
}

// ─── O agente (fatia 2) ──────────────────────────────────────────────────────

const { setModelPort } = await import('../../src/modules/agent/model-port.js')
const { setAgentPortalPort } = await import('../../src/modules/agent/portal-port.js')
const { setTurnScheduler } = await import('../../src/modules/agent/runner.js')
type ModelRequest = import('../../src/modules/agent/model-port.js').ModelRequest
type ModelResponse = import('../../src/modules/agent/model-port.js').ModelResponse
type AgentPortalPort = import('../../src/modules/agent/portal-port.js').AgentPortalPort

/**
 * O provedor do modelo, roteirizado.
 *
 * Cada entrada do roteiro é **uma** chamada: peça uma tool, ou responda. O dublê guarda o
 * que recebeu — e é isso que permite afirmar o que nenhum outro teste afirmaria: que o
 * prefixo do prompt é byte-idêntico entre dois turnos (AC-04 de MOD-AI-02), e que o
 * `tool_result` de erro voltou em vez de ser omitido (AC-05 de MOD-AI-03).
 */
export interface ScriptedTurn {
  /** Peça estas tools. O dublê devolve blocos `tool_use`. */
  tools?: { name: string; input?: Record<string, unknown> }[]
  /** Ou responda isto, no contrato de saída estruturada. */
  reply?: string
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
  handoff?: boolean
  /** Ou estoure, como um provedor fora do ar. */
  fail?: boolean
  usage?: Partial<{
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }>
}

export interface FakeModel {
  /** Tudo o que chegou ao provedor, em ordem. */
  calls: ModelRequest[]
  /** Acrescenta turnos ao roteiro (o dublê consome um por chamada). */
  script(...turns: ScriptedTurn[]): void
}

export function installFakeModel(...turns: ScriptedTurn[]): FakeModel {
  const calls: ModelRequest[] = []
  const roteiro = [...turns]
  let contador = 0

  setModelPort({
    configured: true,
    async complete(request) {
      calls.push(structuredClone(request))
      const turn = roteiro.shift()
      if (!turn) throw new Error('o roteiro do modelo acabou antes das chamadas')
      if (turn.fail) throw new Error('provedor fora do ar (injetado pelo teste)')

      contador += 1
      const usage = {
        inputTokens: turn.usage?.inputTokens ?? 1_000,
        outputTokens: turn.usage?.outputTokens ?? 200,
        cacheReadTokens: turn.usage?.cacheReadTokens ?? (contador > 1 ? 900 : 0),
        cacheWriteTokens: turn.usage?.cacheWriteTokens ?? (contador === 1 ? 900 : 0),
      }

      if (turn.tools?.length) {
        return {
          content: turn.tools.map((tool, index) => ({
            type: 'tool_use',
            id: `toolu_${contador}_${index}`,
            name: tool.name,
            input: tool.input ?? {},
          })) as ModelResponse['content'],
          stopReason: 'tool_use',
          usage,
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              reply: turn.reply ?? 'Certo!',
              sentiment: turn.sentiment ?? 'NEUTRAL',
              handoff: turn.handoff ?? false,
            }),
            citations: null,
          },
        ] as unknown as ModelResponse['content'],
        stopReason: 'end_turn',
        usage,
      }
    },
  })

  return {
    calls,
    script(...next) {
      roteiro.push(...next)
    },
  }
}

/** O modelo sem chave: o estado de uma instalação que nunca configurou o provedor. */
export function installUnconfiguredModel(): void {
  setModelPort({
    configured: false,
    async complete() {
      throw new Error('não deveria ter sido chamado')
    },
  })
}

/**
 * As sete leituras, dubladas.
 *
 * O padrão devolve vazio: um teste que não fala de pets não deve precisar cadastrar um.
 * Quem exercita o **escopo** de verdade (AC-02) não usa este dublê — usa a porta real,
 * com dois tutores no banco.
 */
export function installFakePortal(overrides: Partial<AgentPortalPort> = {}): {
  calls: { method: string; tutorId?: string }[]
} {
  const calls: { method: string; tutorId?: string }[] = []

  setAgentPortalPort({
    async pets(_tenantId, tutorId) {
      calls.push({ method: 'pets', tutorId })
      return overrides.pets ? overrides.pets(_tenantId, tutorId) : []
    },
    async appointments(tenantId, tutorId) {
      calls.push({ method: 'appointments', tutorId })
      if (overrides.appointments) return overrides.appointments(tenantId, tutorId)
      return { upcoming: [], past: [], nextCursor: null, timezone: TEST_TIMEZONE }
    },
    async availability(tenantId, tutorId, input) {
      calls.push({ method: 'availability', tutorId })
      if (overrides.availability) return overrides.availability(tenantId, tutorId, input)
      return {
        slots: [],
        nextAvailable: null,
        durationMin: 60,
        priceCents: 0,
        timezone: TEST_TIMEZONE,
        minNoticeHours: 0,
      }
    },
    async services(tenantId, tutorId, petId) {
      calls.push({ method: 'services', tutorId })
      if (overrides.services) return overrides.services(tenantId, tutorId, petId)
      return { petName: 'Thor', services: [] }
    },
    async finance(tenantId, tutorId) {
      calls.push({ method: 'finance', tutorId })
      if (overrides.finance) return overrides.finance(tenantId, tutorId)
      return {
        balanceCents: 0,
        openDebitsCents: 0,
        oldestOpenDebitAt: null,
        packages: [],
        howToPay: { pixKey: null, phone: null, whatsapp: null, hours: [] },
        timezone: TEST_TIMEZONE,
      }
    },
    async tenant(tenantId) {
      calls.push({ method: 'tenant' })
      if (overrides.tenant) return overrides.tenant(tenantId)
      return {
        name: 'Petshop Teste',
        slug: 'teste',
        logoUrl: null,
        brandColor: null,
        portalEnabled: true,
      }
    },
    async taxi(tenantId, tutorId) {
      calls.push({ method: 'taxi', tutorId })
      if (overrides.taxi) return overrides.taxi(tenantId, tutorId)
      return {
        available: false,
        reason: 'NO_ADDRESS',
        message: 'Sem endereço cadastrado',
        address: null,
        priceCentsPerLeg: null,
        windowMinutes: 60,
      }
    },

    async appointment(tenantId, tutorId, appointmentId) {
      calls.push({ method: 'appointment', tutorId })
      if (overrides.appointment) return overrides.appointment(tenantId, tutorId, appointmentId)
      return agendamentoFalso(appointmentId)
    },

    async book(tenantId, tutorId, input) {
      calls.push({ method: 'book', tutorId })
      if (overrides.book) return overrides.book(tenantId, tutorId, input)
      return {
        id: FAKE_IDS.novoAgendamento,
        status: 'CONFIRMED',
        startsAt: input.startsAt,
        endsAt: input.startsAt,
        petName: 'Thor',
        professionalName: 'Ana',
        services: ['Banho'],
        totalCents: 5_000,
        awaitingApproval: false,
        duplicate: false,
        taxi: [],
        taxiWarning: null,
      }
    },

    async cancelAppointment(tenantId, tutorId, appointmentId) {
      calls.push({ method: 'cancelAppointment', tutorId })
      if (overrides.cancelAppointment) {
        return overrides.cancelAppointment(tenantId, tutorId, appointmentId)
      }
      return { ...agendamentoFalso(appointmentId), status: 'CANCELLED', cancelledLate: false }
    },

    async rescheduleAppointment(tenantId, tutorId, appointmentId, input) {
      calls.push({ method: 'rescheduleAppointment', tutorId })
      if (overrides.rescheduleAppointment) {
        return overrides.rescheduleAppointment(tenantId, tutorId, appointmentId, input)
      }
      return {
        ...agendamentoFalso(FAKE_IDS.novoAgendamento),
        startsAt: input.startsAt,
      }
    },
  })

  return { calls }
}

/**
 * Os ids que o roteiro do modelo usa.
 *
 * Fixos e nomeados porque o teste de escrita os escreve **como o modelo os escreveria**:
 * dentro do argumento de uma tool, em texto. Um `randomUUID()` no meio do roteiro faria
 * o teste montar o argumento a partir do dublê, que é o contrário do que ele prova.
 */
export const FAKE_IDS = {
  pet: '22222222-2222-4222-8222-222222222222',
  servico: '33333333-3333-4333-8333-333333333333',
  profissional: '44444444-4444-4444-8444-444444444444',
  agendamento: '55555555-5555-4555-8555-555555555555',
  novoAgendamento: '66666666-6666-4666-8666-666666666666',
} as const

/** Um horário livre da grade dublada. Vem sempre no mesmo instante. */
export const FAKE_SLOT = '2026-09-24T12:00:00.000Z'

/** A grade com um horário só — o que `proporAgendamento` reconsulta antes de propor. */
export function gradeComUmHorario(startsAt = FAKE_SLOT) {
  return {
    slots: [
      {
        startsAt,
        endsAt: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
        professionalId: FAKE_IDS.profissional,
        professionalName: 'Ana',
      },
    ],
    nextAvailable: startsAt,
    durationMin: 60,
    priceCents: 5_000,
    timezone: TEST_TIMEZONE,
    minNoticeHours: 0,
  }
}

type PortalAppointmentDetail = Awaited<ReturnType<AgentPortalPort['appointment']>>

/** Um agendamento do tutor, cancelável e remarcável, sem taxa. */
export function agendamentoFalso(
  id: string,
  overrides: Partial<PortalAppointmentDetail> = {},
): PortalAppointmentDetail {
  return {
    id,
    status: 'CONFIRMED',
    startsAt: '2026-09-23T12:00:00.000Z',
    endsAt: '2026-09-23T13:00:00.000Z',
    petId: FAKE_IDS.pet,
    petName: 'Thor',
    professionalName: 'Ana',
    services: ['Banho'],
    totalCents: 5_000,
    awaitingApproval: false,
    taxi: [],
    source: 'PORTAL',
    serviceIds: [FAKE_IDS.servico],
    cancelledAt: null,
    cancelledLate: null,
    actions: {
      canCancel: true,
      canReschedule: true,
      cancelIsLate: false,
      cancelFeeCents: 0,
      cancellationWindowHours: 24,
    },
    ...overrides,
  }
}

/** O agendador do turno, trocado por um que só anota — ver `setTurnScheduler`. */
export function captureScheduledTurns(): { ids: string[] } {
  const ids: string[] = []
  setTurnScheduler((_tenantId, conversationId) => {
    ids.push(conversationId)
  })
  return { ids }
}

/** Liga o agente com a janela aberta o dia inteiro, salvo pedido em contrário. */
export async function enableAgent(
  fixture: TenantFixture,
  overrides: {
    opensAt?: string
    closesAt?: string
    monthlyCapCents?: number
    personaName?: string
    tone?: AgentTone
  } = {},
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.agentSettings.upsert({
      where: { tenantId: fixture.tenantId },
      update: { enabled: true, ...overrides },
      create: {
        tenantId: fixture.tenantId,
        enabled: true,
        opensAt: overrides.opensAt ?? '00:00',
        closesAt: overrides.closesAt ?? '23:59',
        ...(overrides.monthlyCapCents === undefined
          ? {}
          : { monthlyCapCents: overrides.monthlyCapCents }),
        ...(overrides.personaName === undefined ? {} : { personaName: overrides.personaName }),
        ...(overrides.tone === undefined ? {} : { tone: overrides.tone }),
      },
    })
  })
}

/** Um pet de verdade, para o teste que exercita o escopo pela porta real. */
export async function givenPet(
  fixture: TenantFixture,
  tutorId: string,
  name = 'Thor',
): Promise<string> {
  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'SMALL', tenantId: null } }),
  ])

  return withTenant(fixture.tenantId, async (tx) => {
    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        speciesId: species.id,
        sizeId: size.id,
        petTutors: { create: { tenantId: fixture.tenantId, tutorId, role: 'PRIMARY' } },
      },
      select: { id: true },
    })
    return pet.id
  })
}
