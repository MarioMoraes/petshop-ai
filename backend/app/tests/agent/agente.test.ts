import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callWebhook,
  captureScheduledTurns,
  closeHarness,
  enableAgent,
  enableMessaging,
  givenPet,
  givenTenant,
  givenTutor,
  givenWhatsapp,
  installFakeMessaging,
  installFakeModel,
  installFakePortal,
  installUnconfiguredModel,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  upsertPayload,
  type TenantFixture,
} from './fixtures.js'

const { answer } = await import('../../src/modules/agent/runner.js')

/**
 * MOD-AI fatia 2 — o agente lê e responde.
 *
 * Todo cenário entra pelo webhook, como na fatia 1, e **o turno é disparado à mão**: em
 * produção ele sai numa promessa solta logo depois do 204, e uma suíte que corresse
 * contra ela disputaria a posse da conversa com o próprio código sob teste. O agendador é
 * trocado por um que só anota (`captureScheduledTurns`), e cada teste chama `answer`
 * quando quer.
 *
 * O provedor é dublado sempre. É o que o §10 do PRD pede — "a suíte inteira roda sem
 * chave de provedor e sem gastar dinheiro" — e o que fica de fora é só o HTTP: o laço de
 * tools, a contabilidade de custo, o contrato de saída e toda decisão de handoff são os
 * de produção.
 */

let tenant: TenantFixture
let tutorId: string
let token: string
let motor: ReturnType<typeof installFakeMessaging>
let agendados: { ids: string[] }

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  motor = installFakeMessaging()
  agendados = captureScheduledTurns()
  tenant = await givenTenant()
  token = await givenWhatsapp(tenant)
  await enableMessaging(tenant)
  await enableAgent(tenant)
  tutorId = await givenTutor(tenant)
})

afterAll(async () => {
  await closeHarness()
})

/** Uma mensagem do tutor pelo webhook, e a conversa que ela abriu. */
async function givenInbound(text = 'que horas é o banho do Thor?'): Promise<string> {
  await callWebhook(token, upsertPayload({ text }))
  const conversation = await ownerPrisma.agentConversation.findFirstOrThrow({
    where: { tenantId: tenant.tenantId },
    orderBy: { createdAt: 'desc' },
  })
  return conversation.id
}

async function conversa(id: string) {
  return ownerPrisma.agentConversation.findUniqueOrThrow({ where: { id } })
}

async function turnos(id: string) {
  return ownerPrisma.agentTurn.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
  })
}

describe('MOD-AI-03 — o agente responde lendo', () => {
  it('AC-01: consulta pela tool e responde ao cliente', async () => {
    const portal = installFakePortal({
      async appointments() {
        return {
          upcoming: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              status: 'SCHEDULED',
              startsAt: '2026-09-18T12:00:00.000Z',
              endsAt: '2026-09-18T13:00:00.000Z',
              petId: '22222222-2222-4222-8222-222222222222',
              petName: 'Thor',
              professionalName: 'Ana',
              services: ['Banho'],
              totalCents: 8000,
              awaitingApproval: false,
              taxi: [],
              actions: {
                canCancel: true,
                canReschedule: true,
                cancelIsLate: false,
                cancelFeeCents: 0,
                cancellationWindowHours: 12,
              },
            },
          ],
          past: [],
          nextCursor: null,
          timezone: 'America/Sao_Paulo',
        }
      },
    })

    const modelo = installFakeModel(
      { tools: [{ name: 'listarProximosAgendamentos' }] },
      { reply: 'O banho do Thor é quinta às 9h.' },
    )

    const id = await givenInbound()
    // O webhook agendou o turno em vez de rodá-lo: é o que a produção faz depois do 204.
    expect(agendados.ids).toEqual([id])

    await answer(tenant.tenantId, id)

    // A tool recebeu o escopo da conversa — e não um tutor vindo dos argumentos. O
    // `pets` na frente é o briefing, que passou a ir no contexto de toda mensagem para
    // poupar do modelo a ida que só serviria para descobrir o id do pet.
    expect(portal.calls).toEqual([
      { method: 'pets', tutorId },
      { method: 'appointments', tutorId },
    ])

    const [, resposta] = await turnos(id)
    expect(resposta?.role).toBe('AGENT')
    expect(resposta?.sentiment).toBe('NEUTRAL')

    expect(motor.sent).toHaveLength(1)
    expect(motor.sent[0]?.text).toContain('O banho do Thor é quinta às 9h.')

    // Responder não tira a conversa do agente: ela continua viva para o próximo turno.
    expect((await conversa(id)).status).toBe('ACTIVE')
    expect(modelo.calls).toHaveLength(2)
  })

  it('§9: a primeira resposta avisa que é atendimento automático, e a segunda não', async () => {
    installFakePortal()
    installFakeModel({ reply: 'Claro!' }, { reply: 'Mais alguma coisa?' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)
    expect(motor.sent[0]?.text).toContain('atendimento automático')

    await callWebhook(token, upsertPayload({ text: 'e o preço?' }))
    await answer(tenant.tenantId, id)
    expect(motor.sent[1]?.text).not.toContain('atendimento automático')
  })

  it('a resposta que não chegou ao cliente sai do histórico, e o aviso de robô volta', async () => {
    installFakePortal()
    const modelo = installFakeModel(
      { reply: 'Tenho banho amanhã às 9h, 10h e 11h. Qual prefere?' },
      { reply: 'Olá! Em que posso ajudar?' },
    )

    const id = await givenInbound('quero marcar banho amanhã')
    await answer(tenant.tenantId, id)

    // O motor recebeu a resposta, mas ela nasceu bloqueada — o número do cliente estava na
    // lista de supressão. É o caso real de 2026-09-23.
    const [, primeira] = await turnos(id)
    expect(primeira?.messageId).toBeTruthy()
    await ownerPrisma.message.create({
      data: {
        id: primeira!.messageId!,
        tenantId: tenant.tenantId,
        tutorId,
        channel: 'WHATSAPP',
        category: 'OPERATIONAL',
        templateKey: 'agent_reply',
        toEncrypted: 'x',
        toHash: 'x'.repeat(64),
        bodyEncrypted: 'x',
        status: 'BLOCKED',
        blockReason: 'SUPPRESSED',
        dedupeKey: `teste-bloqueada-${id}`,
      },
    })

    await callWebhook(token, upsertPayload({ text: 'oi' }))
    await answer(tenant.tenantId, id)

    // O modelo não vê a oferta de horário que o cliente nunca leu…
    const historico = JSON.stringify(modelo.calls[1]?.messages)
    expect(historico).not.toContain('Tenho banho amanhã')
    // …mas continua vendo o que o cliente disse.
    expect(historico).toContain('quero marcar banho amanhã')
    // E o aviso de atendimento automático sai de novo: o primeiro também não chegou.
    expect(motor.sent[1]?.text).toContain('atendimento automático')
  })

  it('AC-02: a tool recusa o pet que não é do cliente da conversa', async () => {
    // Sem dublê do Portal: quem responde é a porta real, e quem recusa é o `assertOwnsPet`
    // do MOD-PORTAL — a mesma função que protege a tela do tutor.
    const outroTutor = await givenTutor(tenant, { phone: '+5511911110000' })
    const petAlheio = await givenPet(tenant, outroTutor, 'Rex')

    const modelo = installFakeModel(
      { tools: [{ name: 'listarServicos', input: { petId: petAlheio } }] },
      { reply: 'Não encontrei esse pet na sua ficha.', handoff: true },
    )

    const id = await givenInbound('quanto custa o banho do Rex?')
    await answer(tenant.tenantId, id)

    // O `tool_result` de erro **voltou** ao modelo, em vez de ser omitido (AC-05).
    const segunda = modelo.calls[1]
    const resultado = JSON.stringify(segunda?.messages.at(-1))
    expect(resultado).toContain('is_error')
    expect((await conversa(id)).status).toBe('HANDOFF')
  })

  it('AC-03: a situação financeira sai em faixa, nunca em valor', async () => {
    installFakePortal({
      async finance() {
        return {
          balanceCents: -34000,
          openDebitsCents: 34000,
          oldestOpenDebitAt: '2026-08-01T00:00:00.000Z',
          packages: [],
          howToPay: { pixKey: 'chave@pix', phone: '(11) 4002-8922', whatsapp: null, hours: [] },
          timezone: 'America/Sao_Paulo',
        }
      },
    })

    const modelo = installFakeModel(
      { tools: [{ name: 'situacaoFinanceira' }] },
      { reply: 'Há valores em aberto na sua conta.' },
    )

    const id = await givenInbound('quanto eu devo?')
    await answer(tenant.tenantId, id)

    const entregue = JSON.stringify(modelo.calls[1]?.messages.at(-1))
    expect(entregue).toContain('temValoresEmAberto')
    // O valor exato não atravessa a porta: o telefone identifica, não autentica.
    expect(entregue).not.toContain('34000')
    expect(entregue).not.toContain('340')
  })

  it('AC-05: a tool que falha não vira resposta inventada', async () => {
    installFakePortal({
      async pets() {
        throw new Error('banco indisponível')
      },
    })

    const modelo = installFakeModel(
      { tools: [{ name: 'listarMeusPets' }] },
      { reply: 'Não consegui consultar agora, vou chamar alguém.', handoff: true },
    )

    const id = await givenInbound('quais são meus pets?')
    await answer(tenant.tenantId, id)

    expect(JSON.stringify(modelo.calls[1]?.messages.at(-1))).toContain('is_error')
    expect((await conversa(id)).handoffReason).toBe('REQUESTED')
  })
})

describe('MOD-AI-02 — contexto e cache', () => {
  it('AC-04: o prefixo do prompt é idêntico entre dois turnos', async () => {
    installFakePortal()
    const modelo = installFakeModel({ reply: 'Oi!' }, { reply: 'Claro.' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)
    await callWebhook(token, upsertPayload({ text: 'e amanhã?' }))
    await answer(tenant.tenantId, id)

    /**
     * **A causa, e não o efeito.** `usage.cache_read_input_tokens > 0` só se observa
     * contra o provedor de verdade; o que se pode afirmar sem gastar dinheiro é o que o
     * produz: prompt de sistema byte a byte igual e a mesma lista de tools, na mesma
     * ordem. Um `new Date()` no prompt de sistema — o erro que o §10 nomeia — quebra
     * este teste na hora, e sem ele o módulo continuaria funcionando com a conta
     * triplicada.
     */
    const [primeira, segunda] = modelo.calls
    expect(segunda?.system).toBe(primeira?.system)
    expect(JSON.stringify(segunda?.tools)).toBe(JSON.stringify(primeira?.tools))

    // E o que varia por turno está **depois** do prefixo, junto da mensagem.
    expect(primeira?.system).not.toContain('agora:')
    expect(JSON.stringify(segunda?.messages.at(-1))).toContain('agora:')
  })

  it('AC-03: a conversa longa demais vai para gente sem chamar o modelo', async () => {
    installFakePortal()
    const modelo = installFakeModel()

    const id = await givenInbound('oi')
    await ownerPrisma.agentConversation.update({ where: { id }, data: { turnCount: 40 } })
    await answer(tenant.tenantId, id)

    expect(modelo.calls).toHaveLength(0)
    const depois = await conversa(id)
    expect(depois.status).toBe('HANDOFF')
    expect(depois.handoffReason).toBe('TOO_LONG')
  })
})

describe('MOD-AI-05 — quando passa para gente', () => {
  it('AC-02: sentimento negativo vira handoff por sentimento', async () => {
    installFakePortal()
    installFakeModel({
      reply: 'Sinto muito. Vou chamar alguém.',
      sentiment: 'NEGATIVE',
      handoff: true,
    })

    const id = await givenInbound('isso é um absurdo')
    await answer(tenant.tenantId, id)

    const depois = await conversa(id)
    expect(depois.status).toBe('HANDOFF')
    expect(depois.handoffReason).toBe('SENTIMENT')
    // O tutor recebeu a frase antes de a conversa mudar de mãos.
    expect(motor.sent[0]?.text).toContain('Vou chamar alguém')
  })

  it('AC-03: três turnos sem consulta que dê certo viram impasse', async () => {
    installFakePortal()
    installFakeModel({ reply: 'Oi!' }, { reply: 'Certo.' }, { reply: 'Entendi.' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)
    await callWebhook(token, upsertPayload({ text: 'e aí?' }))
    await answer(tenant.tenantId, id)
    await callWebhook(token, upsertPayload({ text: 'hein?' }))
    await answer(tenant.tenantId, id)

    const depois = await conversa(id)
    expect(depois.handoffReason).toBe('UNRESOLVED')
    expect(depois.status).toBe('HANDOFF')
  })

  it('RN-09: provedor fora do ar vira handoff, e o tutor recebe uma frase', async () => {
    installFakePortal()
    installFakeModel({ fail: true })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    const depois = await conversa(id)
    expect(depois.status).toBe('HANDOFF')
    expect(depois.handoffReason).toBe('ERROR')
    expect(motor.sent[0]?.text).toContain('chamando alguém')
    // E a posse foi devolvida: o varredor não vai reprocessar o turno.
    expect(depois.pendingAt).toBeNull()
  })

  it('a conversa que a recepção assumiu não é retomada pelo agente', async () => {
    installFakePortal()
    const modelo = installFakeModel()

    const id = await givenInbound('oi')
    await ownerPrisma.agentConversation.update({
      where: { id },
      data: { status: 'HANDOFF', handoffReason: 'REQUESTED' },
    })
    await answer(tenant.tenantId, id)

    expect(modelo.calls).toHaveLength(0)
    expect(motor.sent).toHaveLength(0)
  })
})

describe('MOD-AI-07 — como o agente fala', () => {
  /**
   * A regra de cache que a humanização mais tentou quebrar.
   *
   * Persona e tom **podem** ir ao prompt de sistema: são estáveis por tenant, como o nome
   * da loja. O nome do cliente não pode, e é justamente o que parece mais natural de
   * escrever ali — ele muda a cada conversa, e no prefixo faria cada tutor pagar o prompt
   * inteiro de novo, em silêncio (§10).
   */
  it('a persona e o tom vão no prompt; o nome do cliente vai na mensagem', async () => {
    await ownerPrisma.tutor.update({ where: { id: tutorId }, data: { fullName: 'Marina Prado' } })
    await enableAgent(tenant, { personaName: 'Lia', tone: 'CALOROSO' })
    installFakePortal()
    const modelo = installFakeModel({ reply: 'Oi!' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    const system = modelo.calls[0]?.system ?? ''
    expect(system).toContain('Lia')
    expect(system).toContain('COMO VOCÊ FALA')
    // O tom escolhido, e não o de outro tenant.
    expect(system).toContain('conhece o cliente de balcão')

    expect(system).not.toContain('Marina')
    expect(JSON.stringify(modelo.calls[0]?.messages.at(-1))).toContain('Marina')
  })

  /** O nome social é o nome pelo qual a pessoa quer ser chamada — e a saudação é onde dói. */
  it('o nome social ganha do nome completo na saudação', async () => {
    await ownerPrisma.tutor.update({
      where: { id: tutorId },
      data: { fullName: 'Marina Prado', socialName: 'Mari' },
    })
    installFakePortal()
    const modelo = installFakeModel({ reply: 'Oi!' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    const mensagem = JSON.stringify(modelo.calls[0]?.messages.at(-1))
    expect(mensagem).toContain('Mari')
    expect(mensagem).not.toContain('Marina')
  })

  /**
   * §9 do PRD: o petshop escolhe o **nome**, e não o aviso. Uma persona que substituísse
   * a frase seria a forma de apagá-la sem parecer que se apagou.
   */
  it('a persona entra dentro do aviso de automação, nunca no lugar dele', async () => {
    await enableAgent(tenant, { personaName: 'Lia' })
    installFakePortal()
    installFakeModel({ reply: 'Claro!' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    expect(motor.sent[0]?.text).toContain('Lia')
    expect(motor.sent[0]?.text).toContain('atendimento automático')
  })

  /** O tom de antes da humanização continua disponível, e continua sendo o que era. */
  it('o tom sóbrio segue proibindo emoji', async () => {
    await enableAgent(tenant, { tone: 'SOBRIO' })
    installFakePortal()
    const modelo = installFakeModel({ reply: 'Oi!' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    const system = modelo.calls[0]?.system ?? ''
    expect(system).toContain('Sem emoji')
    expect(system).not.toContain('Emoji é ocasional')
  })
})

describe('MOD-AI — o briefing que poupa idas ao modelo', () => {
  const PET = '33333333-3333-4333-8333-333333333333'
  const SERVICO = '44444444-4444-4444-8444-444444444444'

  function umPet(overrides: Record<string, unknown> = {}) {
    return {
      id: PET,
      name: 'Thor',
      species: 'Cachorro',
      breed: 'Vira-lata',
      ageLabel: '3 anos',
      photoUrl: null,
      inMemoriam: false,
      lastAttendanceAt: null,
      nextAppointment: null,
      ...overrides,
    }
  }

  /**
   * **A razão de existir do briefing é latência, e ela foi medida.**
   *
   * `listarMeusPets` → `listarServicos` → `consultarDisponibilidade` eram três idas ao
   * modelo em série antes de o agente ter o que responder — quatro chamadas no turno de
   * agendamento. Com os dois primeiros elos prontos no contexto, são duas.
   */
  it('os pets e os serviços chegam na mensagem, com os ids de verdade', async () => {
    installFakePortal({
      async pets() {
        return [umPet()] as never
      },
      async services() {
        return {
          petName: 'Thor',
          services: [
            {
              id: SERVICO,
              name: 'Banho',
              description: null,
              category: 'BATH',
              priceCents: 8000,
              durationMin: 60,
            },
          ],
        }
      },
    })
    const modelo = installFakeModel({ reply: 'Oi!' })

    const id = await givenInbound('quero marcar um banho')
    await answer(tenant.tenantId, id)

    // O conteúdo cru, e não o `JSON.stringify` da mensagem: re-serializar escapa as
    // aspas do briefing e faz a asserção comparar contra `\"servicos\"`.
    const mensagem = String(modelo.calls[0]?.messages.at(-1)?.content ?? '')
    expect(mensagem).toContain(PET)
    expect(mensagem).toContain(SERVICO)
    expect(mensagem).toContain('Banho')
    // O preço vai formatado, como a tool o entregaria — uma segunda forma de dizer a
    // mesma coisa seria uma segunda chance de o modelo entender diferente. O
    // `formatBRL` separa com espaço **não separável** (U+00A0), e normalizar aqui é o
    // que impede o teste de falhar por um caractere invisível.
    expect(mensagem.replace(/ /g, ' ')).toContain('R$ 80,00')

    // E o prefixo em cache continua intocado: isto varia por cliente.
    expect(modelo.calls[0]?.system).not.toContain('Thor')
  })

  /**
   * Nulo é "não consegui saber", e lista vazia seria "não há serviço nenhum". Com a
   * segunda o agente diria ao cliente que não dá para marcar nada.
   */
  it('serviço que o domínio recusa vira nulo, nunca lista vazia', async () => {
    installFakePortal({
      async pets() {
        return [umPet()] as never
      },
      async services() {
        throw new Error('agendamento online desligado')
      },
    })
    const modelo = installFakeModel({ reply: 'Oi!' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    const mensagem = String(modelo.calls[0]?.messages.at(-1)?.content ?? '')
    expect(mensagem).toContain('Thor')
    expect(mensagem).toContain('"servicos":null')
  })

  /** O briefing é atalho, não requisito: falhar nele não pode custar a resposta. */
  it('a falha do briefing não derruba o turno', async () => {
    installFakePortal({
      async pets() {
        throw new Error('banco fora do ar')
      },
    })
    installFakeModel({ reply: 'Oi! Como posso ajudar?' })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    expect(motor.sent[0]?.text).toContain('Como posso ajudar?')
    expect((await conversa(id)).status).toBe('ACTIVE')
  })
})

describe('MOD-AI-07 e 08 — configuração e teto', () => {
  it('AC-02: com o agente desligado a conversa vai para a fila e o modelo não é chamado', async () => {
    await ownerPrisma.agentSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { enabled: false },
    })
    installFakePortal()
    const modelo = installFakeModel()

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    expect(modelo.calls).toHaveLength(0)
    const depois = await conversa(id)
    expect(depois.status).toBe('HANDOFF')
    expect(depois.handoffReason).toBe('DISABLED')
    // O inbox continua funcionando: a mensagem está lá, com a linha e o turno.
    expect(await turnos(id)).toHaveLength(1)
  })

  it('sem chave de provedor o agente se comporta como desligado', async () => {
    installFakePortal()
    installUnconfiguredModel()

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    expect((await conversa(id)).handoffReason).toBe('DISABLED')
  })

  it('AC-03: fora da janela o tutor recebe o horário e ninguém chama o modelo', async () => {
    await enableAgent(tenant, { opensAt: '08:00', closesAt: '08:01' })
    installFakePortal()
    const modelo = installFakeModel()

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    expect(modelo.calls).toHaveLength(0)
    expect(motor.sent[0]?.text).toContain('das 08:00 às 08:01')
    // `OUT_OF_HOURS` desde a fatia 3. Era `DISABLED`, e a fila lia "o atendimento
    // automático está desligado" quando a verdade era "ainda não abriu".
    expect((await conversa(id)).handoffReason).toBe('OUT_OF_HOURS')
  })

  it('AC-02 de MOD-AI-08: atingido o teto do mês, tudo vai para a fila', async () => {
    await enableAgent(tenant, { monthlyCapCents: 1 })
    installFakePortal()
    installFakeModel({ reply: 'Oi!' }, { reply: 'De novo oi!' })

    const primeiro = await givenInbound('oi')
    await answer(tenant.tenantId, primeiro)
    // O primeiro turno passou e cobrou; o gasto do mês já estourou o teto de um centavo.
    expect((await conversa(primeiro)).costMillicents).toBeGreaterThan(0)

    await callWebhook(token, upsertPayload({ text: 'de novo' }))
    await answer(tenant.tenantId, primeiro)

    const depois = await conversa(primeiro)
    expect(depois.status).toBe('HANDOFF')
    expect(depois.handoffReason).toBe('BUDGET')
  })

  it('RN-13: o custo do turno sai do usage e acumula na conversa', async () => {
    installFakePortal()
    installFakeModel({
      reply: 'Oi!',
      usage: { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })

    const id = await givenInbound('oi')
    await answer(tenant.tenantId, id)

    const [, resposta] = await turnos(id)
    expect(resposta?.inputTokens).toBe(2_000)
    expect(resposta?.outputTokens).toBe(500)
    // 2.000 × US$5/MTok + 500 × US$25/MTok, a R$ 5,50 — na casa dos 12 centavos.
    expect(resposta?.costMillicents).toBeGreaterThan(10_000)
    expect((await conversa(id)).costMillicents).toBe(resposta?.costMillicents)
  })
})

describe('MOD-AI — as rotas de configuração', () => {
  it('o administrador liga o agente pela tela', async () => {
    const { callApi, asAdmin } = await import('./fixtures.js')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: '/v1/agent/settings',
      payload: { enabled: true, opensAt: '09:00', closesAt: '18:00', monthlyCapCents: 30000 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      enabled: true,
      opensAt: '09:00',
      closesAt: '18:00',
      monthlyCapCents: 30000,
      canEnable: true,
    })
  })

  it('janela invertida é recusada antes de chegar ao banco', async () => {
    const { callApi, asAdmin } = await import('./fixtures.js')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: '/v1/agent/settings',
      payload: { opensAt: '19:00', closesAt: '08:00' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('a recepção lê a configuração e não a muda', async () => {
    const { callApi, asReceptionist } = await import('./fixtures.js')
    const recepcao = await asReceptionist(tenant)

    expect(
      (await callApi({ ...recepcao, method: 'GET', url: '/v1/agent/settings' })).statusCode,
    ).toBe(200)

    const recusa = await callApi({
      ...recepcao,
      method: 'PATCH',
      url: '/v1/agent/settings',
      payload: { enabled: false },
    })
    expect(recusa.statusCode).toBe(403)
  })
})
