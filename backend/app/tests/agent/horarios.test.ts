import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  FAKE_IDS,
  FAKE_SLOT,
  callWebhook,
  captureScheduledTurns,
  closeHarness,
  enableAgent,
  enableMessaging,
  givenTenant,
  givenTutor,
  givenWhatsapp,
  gradeComUmHorario,
  installFakeMessaging,
  installFakeModel,
  installFakePortal,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  TEST_TIMEZONE,
  upsertPayload,
  type TenantFixture,
} from './fixtures.js'

const { answer } = await import('../../src/modules/agent/runner.js')

/**
 * **O que o modelo enxerga de um horário, e o que ele recebe de volta de uma proposta.**
 *
 * Os três testes daqui existem por causa de uma conversa real que não marcou nada: o
 * agente ofereceu "13:00" para um horário das 10:00, disse que a profissional só tinha
 * um horário livre quando havia sessenta e seis, e repetiu a mesma pergunta de
 * confirmação depois do "sim" do cliente. Nenhuma das três coisas era do modelo — as
 * três estavam no que o processo entregava a ele:
 *
 * 1. o instante descia em UTC, e um modelo repassa o número que leu;
 * 2. a grade era cortada nos dez primeiros *slots*, que com dois profissionais na agenda
 *    são cinco horários — a primeira hora do dia;
 * 3. o código da proposta vivia dentro do `tool_result` do turno anterior, e o histórico
 *    entre turnos é só texto: no turno do "sim" o modelo não tinha o que confirmar.
 *
 * A suíte antiga não apanhava o terceiro porque lia o token **do banco** e o entregava ao
 * dublê. Aqui o dublê só pode usar o que chegou nas mensagens, que é a situação do
 * provedor de verdade.
 */

let tenant: TenantFixture
let token: string

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  installFakeMessaging()
  captureScheduledTurns()
  tenant = await givenTenant()
  token = await givenWhatsapp(tenant)
  await enableMessaging(tenant)
  await enableAgent(tenant)
  await givenTutor(tenant)
})

afterAll(async () => {
  await closeHarness()
})

async function givenInbound(text = 'tem horário quinta?'): Promise<string> {
  await callWebhook(token, upsertPayload({ text }))
  const conversation = await ownerPrisma.agentConversation.findFirstOrThrow({
    where: { tenantId: tenant.tenantId },
    orderBy: { createdAt: 'desc' },
  })
  return conversation.id
}

/** Tudo o que o modelo recebeu na chamada `indice`, como texto. */
function recebido(messages: unknown): string {
  return JSON.stringify(messages)
}

/** Uma grade de um dia inteiro: `horarios` instantes, cada um com dois profissionais. */
function gradeDoDia(horarios: number) {
  const primeiro = new Date(FAKE_SLOT).getTime()
  const slots = []
  for (let passo = 0; passo < horarios; passo += 1) {
    const startsAt = new Date(primeiro + passo * 30 * 60_000).toISOString()
    // Dois profissionais no mesmo instante: é este par que fazia dez slots valerem
    // cinco horários.
    slots.push({
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
      professionalId: FAKE_IDS.profissional,
      professionalName: 'Ana',
    })
    slots.push({
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
      professionalId: '77777777-7777-4777-8777-777777777777',
      professionalName: 'Marcelo',
    })
  }
  return { ...gradeComUmHorario(), slots }
}

describe('o horário que o agente lê', () => {
  it('desce na hora do estabelecimento, e nunca em UTC', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    const modelo = installFakeModel(
      {
        tools: [
          {
            name: 'consultarDisponibilidade',
            input: { petId: FAKE_IDS.pet, serviceIds: [FAKE_IDS.servico], date: '2026-09-24' },
          },
        ],
      },
      { reply: 'Tem sim, às 09:00.' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const grade = recebido(modelo.calls[1]?.messages.at(-1))

    // `FAKE_SLOT` é meio-dia em Greenwich e nove da manhã em São Paulo. O agente
    // oferecia "12:00" — três horas depois da porta abrir.
    expect(grade).toContain('09:00')
    expect(grade).not.toContain('12:00')
    // Nem o `Z` do instante cru sobra em lugar nenhum do que ele lê.
    expect(grade).not.toContain('T12:00:00.000Z')
    // O que ele devolve numa proposta carrega o fuso junto, e é o mesmo instante.
    expect(grade).toContain('2026-09-24T09:00:00-03:00')
    expect(new Date('2026-09-24T09:00:00-03:00').getTime()).toBe(new Date(FAKE_SLOT).getTime())
  })

  it('o horário com fuso volta na proposta e reencontra o mesmo slot', async () => {
    const portal = installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      {
        tools: [
          {
            name: 'proporAgendamento',
            input: {
              petId: FAKE_IDS.pet,
              serviceIds: [FAKE_IDS.servico],
              professionalId: FAKE_IDS.profissional,
              // Como o modelo o leu na grade: a hora de parede, com o offset.
              startsAt: '2026-09-24T09:00:00-03:00',
            },
          },
        ],
      },
      { reply: 'Quinta às 09:00 com a Ana. Confirmo?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const viva = await ownerPrisma.agentToolCall.findFirstOrThrow({
      where: { conversationId, status: 'PROPOSED' },
    })
    expect(viva.tool).toBe('proporAgendamento')
    // O resumo do painel sempre esteve na hora certa; agora as duas versões concordam.
    expect(viva.resultSummary).toContain('09:00')
    expect(portal.calls.map((call) => call.method)).not.toContain('book')
  })
})

describe('a grade que o agente recebe', () => {
  it('cobre o dia inteiro, e não só a primeira hora', async () => {
    // Doze horários, de meia em meia hora, com dois profissionais em cada: vinte e
    // quatro slots. O corte antigo, de dez slots, parava no quinto horário.
    installFakePortal({
      async availability() {
        return gradeDoDia(12)
      },
    })
    const modelo = installFakeModel(
      {
        tools: [
          {
            name: 'consultarDisponibilidade',
            input: { petId: FAKE_IDS.pet, serviceIds: [FAKE_IDS.servico], date: '2026-09-24' },
          },
        ],
      },
      { reply: 'Temos vários horários.' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const grade = recebido(modelo.calls[1]?.messages.at(-1))

    expect(grade).toContain('09:00')
    // O último horário do dia — o que o corte por slot escondia.
    expect(grade).toContain('14:30')
    // Os dois profissionais do mesmo horário vêm juntos, e o id de cada um aparece uma
    // vez só, na tabela: é o que deixa a grade do dia inteiro caber.
    expect(grade).toContain('Marcelo')
    expect(grade).toContain('profissionais')
    expect(grade.split(FAKE_IDS.profissional).length - 1).toBe(1)
    expect(grade).not.toContain('observacao')
  })

  it('quando corta, diz que cortou', async () => {
    installFakePortal({
      async availability() {
        return gradeDoDia(60)
      },
    })
    const modelo = installFakeModel(
      {
        tools: [
          {
            name: 'consultarDisponibilidade',
            input: { petId: FAKE_IDS.pet, serviceIds: [FAKE_IDS.servico], date: '2026-09-24' },
          },
        ],
      },
      { reply: 'Temos muitos horários. Prefere de manhã ou à tarde?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const grade = recebido(modelo.calls[1]?.messages.at(-1))

    // Cortar calado é o que produzia "a Ana só tem 13:00" com o dia livre depois disso.
    expect(grade).toContain('observacao')
    expect(grade).toContain('20 horário')
  })
})

describe('a proposta em aberto no turno seguinte', () => {
  it('o código da proposta chega ao modelo pelo contexto da mensagem', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      {
        tools: [
          {
            name: 'proporAgendamento',
            input: {
              petId: FAKE_IDS.pet,
              serviceIds: [FAKE_IDS.servico],
              professionalId: FAKE_IDS.profissional,
              startsAt: FAKE_SLOT,
            },
          },
        ],
      },
      { reply: 'Quinta às 09:00 com a Ana, R$ 50,00. Confirmo?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const viva = await ownerPrisma.agentToolCall.findFirstOrThrow({
      where: { conversationId, status: 'PROPOSED' },
    })

    // O turno do "sim". O dublê responde texto: o que se afirma aqui é o que ele
    // **recebeu**, porque era isso que faltava para `confirmarProposta` existir para ele.
    const modelo = installFakeModel({ reply: 'Pronto!' })
    await callWebhook(token, upsertPayload({ text: 'sim' }))
    await answer(tenant.tenantId, conversationId)

    const contexto = recebido(modelo.calls[0]?.messages.at(-1))
    expect(contexto).toContain(viva.confirmationToken)
    expect(contexto).toContain('proposta em aberto')
    expect(contexto).toContain('confirmarProposta')
    // O resumo vem junto para o modelo saber a que o "sim" se refere.
    expect(contexto).toContain('09:00')
  })

  it('a proposta vencida não volta ao contexto, e não é fechada pela leitura', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      {
        tools: [
          {
            name: 'proporAgendamento',
            input: {
              petId: FAKE_IDS.pet,
              serviceIds: [FAKE_IDS.servico],
              professionalId: FAKE_IDS.profissional,
              startsAt: FAKE_SLOT,
            },
          },
        ],
      },
      { reply: 'Confirmo?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const viva = await ownerPrisma.agentToolCall.findFirstOrThrow({
      where: { conversationId, status: 'PROPOSED' },
    })
    await ownerPrisma.agentToolCall.update({
      where: { id: viva.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })

    const modelo = installFakeModel({ reply: 'Vou ver de novo.' })
    await callWebhook(token, upsertPayload({ text: 'sim' }))
    await answer(tenant.tenantId, conversationId)

    const contexto = recebido(modelo.calls[0]?.messages.at(-1))
    expect(contexto).not.toContain(viva.confirmationToken)

    // Quem distingue `EXPIRED` de `SUPERSEDED` é o fim do turno, e é essa diferença que
    // o painel conta. Um turno de leitura não pode resolvê-la por ele.
    const depois = await ownerPrisma.agentToolCall.findUniqueOrThrow({ where: { id: viva.id } })
    expect(depois.status).toBe('PROPOSED')
  })
})

/** A suíte inteira roda no fuso do tenant de teste, que não é UTC — é o que a prova exige. */
it('o fuso do tenant de teste não é UTC', () => {
  expect(TEST_TIMEZONE).toBe('America/Sao_Paulo')
})
