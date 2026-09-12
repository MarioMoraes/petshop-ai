import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AppError, formatBRL } from '@petshop/shared-types'
import {
  FAKE_IDS,
  FAKE_SLOT,
  agendamentoFalso,
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
 * MOD-AI-04 — a escrita em duas etapas.
 *
 * O que a suíte prova é sempre a mesma coisa, de seis ângulos: **nada é gravado antes de
 * o tutor confirmar a proposta certa**. A proposta é uma linha com token e prazo, e o
 * "sim" do turno seguinte aponta para ela — não para o que o modelo lembra de ter dito.
 *
 * O modelo é dublado, como na fatia 2, e as portas do Portal também. O que **não** é
 * dublado é o ciclo da proposta: o token, o índice único, a expiração e a posse saem do
 * banco de verdade, porque é neles que as duas mensagens simultâneas se resolvem.
 */

let tenant: TenantFixture
let tutorId: string
let token: string
let agendados: { ids: string[] }

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  installFakeMessaging()
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
async function givenInbound(text = 'dá pra marcar banho quinta?'): Promise<string> {
  await callWebhook(token, upsertPayload({ text }))
  const conversation = await ownerPrisma.agentConversation.findFirstOrThrow({
    where: { tenantId: tenant.tenantId },
    orderBy: { createdAt: 'desc' },
  })
  return conversation.id
}

async function propostas(conversationId: string) {
  return ownerPrisma.agentToolCall.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  })
}

/** A proposta viva da conversa, com o token que o modelo recebeu. */
async function propostaViva(conversationId: string) {
  return ownerPrisma.agentToolCall.findFirstOrThrow({
    where: { conversationId, status: 'PROPOSED' },
  })
}

async function conversa(id: string) {
  return ownerPrisma.agentConversation.findUniqueOrThrow({ where: { id } })
}

/**
 * Uma janela de atendimento que **não** contém o agora, qualquer que seja a hora.
 *
 * Calculada e não fixa: `00:00`–`00:01` passaria o ano inteiro e falharia uma vez por
 * dia, à meia-noite, na máquina de quem estivesse rodando a suíte.
 */
function janelaFechada(): { opensAt: string; closesAt: string } {
  const hora = Number(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: TEST_TIMEZONE,
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  )
  return hora < 12
    ? { opensAt: '13:00', closesAt: '14:00' }
    : { opensAt: '01:00', closesAt: '02:00' }
}

/** Os argumentos da proposta, como o modelo os mandaria. */
const ARGS_AGENDAMENTO = {
  petId: FAKE_IDS.pet,
  serviceIds: [FAKE_IDS.servico],
  professionalId: FAKE_IDS.profissional,
  startsAt: FAKE_SLOT,
}

describe('MOD-AI-04 — a proposta', () => {
  it('AC-01: propor não grava nada, e deixa uma linha PROPOSED com token', async () => {
    const portal = installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Quinta, 24/09 às 09:00 com a Ana, R$ 50,00. Confirma?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    // Nada foi marcado: a porta de escrita não foi tocada.
    expect(portal.calls.map((call) => call.method)).not.toContain('book')

    const viva = await propostaViva(conversationId)
    expect(viva.tool).toBe('proporAgendamento')
    expect(viva.confirmationToken).toHaveLength(32)
    expect(viva.expiresAt).not.toBeNull()
    // A linha aponta para o turno em que a proposta foi feita.
    expect(viva.turnId).not.toBeNull()
  })

  it('a proposta reconsulta a grade e recusa o horário que não está mais livre', async () => {
    installFakePortal({
      async availability() {
        // A grade voltou vazia: o horário que o modelo escolheu sumiu entre a consulta e
        // a proposta, que é o caso real de dois tutores marcando ao mesmo tempo.
        return { ...gradeComUmHorario(), slots: [] }
      },
    })
    const modelo = installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Esse horário acabou de sair. Quer ver outro?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    expect(await propostas(conversationId)).toHaveLength(1)
    expect((await propostas(conversationId))[0]?.status).toBe('FAILED')

    // O modelo leu a recusa como `tool_result` de erro, e não como resultado válido.
    const resultado = modelo.calls[1]?.messages.at(-1)
    expect(JSON.stringify(resultado)).toContain('is_error')
  })

  it('AC-04: a proposta nova supera a anterior, e só uma fica viva', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma quinta às 09:00?' },
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'E quinta que vem, às 09:00?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    await callWebhook(token, upsertPayload({ text: 'na verdade, na semana que vem' }))
    await answer(tenant.tenantId, conversationId)

    const todas = await propostas(conversationId)
    expect(todas).toHaveLength(2)
    expect(todas.filter((linha) => linha.status === 'PROPOSED')).toHaveLength(1)
    expect(todas[0]?.status).toBe('SUPERSEDED')
    expect(todas[0]?.resolvedAt).not.toBeNull()
  })
})

describe('MOD-AI-04 — a confirmação', () => {
  it('AC-02: o "sim" com o token grava pela mesma função que o Portal usa', async () => {
    const portal = installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma quinta às 09:00 com a Ana?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)
    const viva = await propostaViva(conversationId)

    installFakeModel(
      {
        tools: [
          { name: 'confirmarProposta', input: { confirmationToken: viva.confirmationToken } },
        ],
      },
      { reply: 'Pronto! Marquei quinta às 09:00.' },
    )
    await callWebhook(token, upsertPayload({ text: 'isso, pode confirmar' }))
    await answer(tenant.tenantId, conversationId)

    expect(portal.calls.map((call) => call.method)).toContain('book')

    const linha = await ownerPrisma.agentToolCall.findUniqueOrThrow({ where: { id: viva.id } })
    expect(linha.status).toBe('CONFIRMED')
    expect(linha.resultSummary).toBe('agendamento criado')

    // AC-07: a trilha diz qual conversa pediu, que é o que o `actor_user_id` nulo do
    // domínio não consegue dizer.
    const trilha = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, action: 'agent.booking_created' },
    })
    expect(trilha.after).toMatchObject({ conversationId, tutorId })
  })

  it('AC-03: a proposta vencida é recusada, e o agente é mandado consultar de novo', async () => {
    const portal = installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)
    const viva = await propostaViva(conversationId)

    // Quinze minutos depois. O horário pode ter sido tomado no meio, e é por isso que a
    // confirmação sobre uma proposta velha não vale.
    await ownerPrisma.agentToolCall.update({
      where: { id: viva.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })

    const modelo = installFakeModel(
      {
        tools: [
          { name: 'confirmarProposta', input: { confirmationToken: viva.confirmationToken } },
        ],
      },
      { reply: 'Esse horário expirou, deixa eu ver de novo.' },
    )
    await callWebhook(token, upsertPayload({ text: 'sim' }))
    await answer(tenant.tenantId, conversationId)

    expect(portal.calls.map((call) => call.method)).not.toContain('book')
    const linha = await ownerPrisma.agentToolCall.findUniqueOrThrow({ where: { id: viva.id } })
    expect(linha.status).toBe('EXPIRED')

    const resultado = JSON.stringify(modelo.calls[1]?.messages.at(-1))
    expect(resultado).toContain('venceu')
    expect(resultado).toContain('is_error')
  })

  it('token errado não confirma nada, e a proposta continua viva', async () => {
    const portal = installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    installFakeModel(
      { tools: [{ name: 'confirmarProposta', input: { confirmationToken: 'a'.repeat(32) } }] },
      { reply: 'Deixa eu confirmar de novo com você.' },
    )
    await callWebhook(token, upsertPayload({ text: 'sim' }))
    await answer(tenant.tenantId, conversationId)

    expect(portal.calls.map((call) => call.method)).not.toContain('book')
    expect((await propostaViva(conversationId)).status).toBe('PROPOSED')
  })

  it('AC-05: o gate que recusa depois do sim manda a conversa para gente', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
      async book() {
        // ERR_AGENDA_008 traduzido pelo Portal: a mensagem traz o valor exato da dívida,
        // que é justamente o que não pode atravessar este canal (RN-01).
        throw new AppError(
          'ERR_AGENDA_008',
          'Há R$ 240,00 em aberto na sua conta. Fale com o estabelecimento para marcar este horário.',
        )
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)
    const viva = await propostaViva(conversationId)

    const modelo = installFakeModel(
      {
        tools: [
          { name: 'confirmarProposta', input: { confirmationToken: viva.confirmationToken } },
        ],
      },
      { reply: 'Não consegui concluir por aqui. Já estou chamando alguém da equipe.' },
    )
    await callWebhook(token, upsertPayload({ text: 'sim' }))
    await answer(tenant.tenantId, conversationId)

    expect((await conversa(conversationId)).status).toBe('HANDOFF')
    expect((await conversa(conversationId)).handoffReason).toBe('WRITE_FAILED')

    const linha = await ownerPrisma.agentToolCall.findUniqueOrThrow({ where: { id: viva.id } })
    expect(linha.status).toBe('FAILED')
    // O motivo completo fica no registro, que é onde a recepção o lê.
    expect(linha.resultSummary).toContain('ERR_AGENDA_008')

    // **E não chega ao modelo.** O texto do domínio foi escrito para uma tela com sessão
    // iniciada, e diz o valor da dívida.
    expect(JSON.stringify(modelo.calls[1]?.messages)).not.toContain('240,00')
  })

  it('o horário tomado no meio não vira handoff: o agente propõe outro', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
      async book() {
        throw new AppError(
          'ERR_AGENDA_004',
          'Este horário acabou de ser preenchido. Escolha um dos horários próximos.',
        )
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)
    const viva = await propostaViva(conversationId)

    installFakeModel(
      {
        tools: [
          { name: 'confirmarProposta', input: { confirmationToken: viva.confirmationToken } },
        ],
      },
      { reply: 'Esse acabou de sair. Tenho às 11:00, serve?' },
    )
    await callWebhook(token, upsertPayload({ text: 'sim' }))
    await answer(tenant.tenantId, conversationId)

    // A conversa continua com o agente: é um caso que ele resolve sozinho.
    expect((await conversa(conversationId)).status).toBe('ACTIVE')
  })
})

describe('MOD-AI-04 — cancelar e remarcar', () => {
  it('o cancelamento tardio diz a taxa na proposta, antes do sim', async () => {
    const portal = installFakePortal({
      async appointment(_tenantId, _tutorId, appointmentId) {
        return agendamentoFalso(appointmentId, {
          actions: {
            canCancel: true,
            canReschedule: true,
            cancelIsLate: true,
            cancelFeeCents: 2_500,
            cancellationWindowHours: 24,
          },
        })
      },
    })
    const modelo = installFakeModel(
      {
        tools: [{ name: 'proporCancelamento', input: { appointmentId: FAKE_IDS.agendamento } }],
      },
      { reply: 'Cancelar agora gera uma taxa de R$ 25,00. Confirma?' },
    )

    const conversationId = await givenInbound('quero cancelar o banho de amanhã')
    await answer(tenant.tenantId, conversationId)

    expect(portal.calls.map((call) => call.method)).not.toContain('cancelAppointment')
    // `formatBRL` e não o literal: o espaço do "R$" do ICU é um NBSP, e um teste que o
    // digitasse à mão falharia por um caractere invisível.
    expect(JSON.stringify(modelo.calls[1]?.messages.at(-1))).toContain(formatBRL(2_500))

    const viva = await propostaViva(conversationId)
    expect(viva.tool).toBe('proporCancelamento')
    expect(viva.resultSummary).toBe('propôs cancelar, com taxa')
  })

  it('o agendamento que não pode mais ser cancelado não vira proposta', async () => {
    installFakePortal({
      async appointment(_tenantId, _tutorId, appointmentId) {
        return agendamentoFalso(appointmentId, {
          actions: {
            canCancel: false,
            canReschedule: false,
            cancelIsLate: false,
            cancelFeeCents: 0,
            cancellationWindowHours: 24,
          },
        })
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporCancelamento', input: { appointmentId: FAKE_IDS.agendamento } }] },
      { reply: 'Esse já não dá para cancelar por aqui.' },
    )

    const conversationId = await givenInbound('cancela o banho')
    await answer(tenant.tenantId, conversationId)

    expect(
      await ownerPrisma.agentToolCall.count({ where: { conversationId, status: 'PROPOSED' } }),
    ).toBe(0)
  })

  it('a remarcação usa os serviços do agendamento, e não os que o modelo escolher', async () => {
    let pedido: { serviceIds: string[] } | null = null
    installFakePortal({
      async appointment(_tenantId, _tutorId, appointmentId) {
        return agendamentoFalso(appointmentId)
      },
      async availability(_tenantId, _tutorId, input) {
        pedido = { serviceIds: input.serviceIds }
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      {
        tools: [
          {
            name: 'proporRemarcacao',
            input: {
              appointmentId: FAKE_IDS.agendamento,
              professionalId: FAKE_IDS.profissional,
              startsAt: FAKE_SLOT,
            },
          },
        ],
      },
      { reply: 'Posso mover para quinta às 09:00. Confirma?' },
    )

    const conversationId = await givenInbound('dá pra passar pra quinta?')
    await answer(tenant.tenantId, conversationId)

    expect(pedido).toEqual({ serviceIds: [FAKE_IDS.servico] })
    expect((await propostaViva(conversationId)).tool).toBe('proporRemarcacao')
  })
})

describe('MOD-AI-04 — o registro do que o agente fez', () => {
  it('a leitura também vira linha, com o resumo em claro e os argumentos cifrados', async () => {
    installFakePortal()
    installFakeModel(
      { tools: [{ name: 'listarMeusPets' }] },
      { reply: 'Você ainda não tem pet cadastrado por aqui.' },
    )

    const conversationId = await givenInbound('quais são meus pets?')
    await answer(tenant.tenantId, conversationId)

    const [linha] = await propostas(conversationId)
    expect(linha?.tool).toBe('listarMeusPets')
    expect(linha?.status).toBe('EXECUTED')
    expect(linha?.resultSummary).toBe('nenhum pet')
    // O corpo cifrado não é legível — é o mesmo contrato de `agent_turns.content`.
    expect(linha?.argumentsEncrypted).not.toContain('petId')
  })

  it('a tela da conversa mostra o que o agente fez, sem os argumentos', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma?', handoff: true },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const { findConversation } = await import('../../src/modules/agent/queries.js')
    const detalhe = await findConversation(tenant.tenantId, conversationId)

    // Uma linha só: a reconsulta da grade que `proporAgendamento` faz por dentro não é
    // uma chamada do modelo, e registrá-la encheria a conversa de ruído que a recepção
    // não pediu.
    expect(detalhe.toolCalls).toHaveLength(1)
    expect(detalhe.toolCalls[0]).toMatchObject({
      tool: 'proporAgendamento',
      status: 'PROPOSED',
      resultSummary: expect.stringContaining('propôs marcar'),
    })
    expect(JSON.stringify(detalhe.toolCalls)).not.toContain(FAKE_IDS.pet)
  })

  it('a conversa encerrada não deixa proposta pendurada na tela', async () => {
    installFakePortal({
      async availability() {
        return gradeComUmHorario()
      },
    })
    installFakeModel(
      { tools: [{ name: 'proporAgendamento', input: ARGS_AGENDAMENTO }] },
      { reply: 'Confirma?' },
    )

    const conversationId = await givenInbound()
    await answer(tenant.tenantId, conversationId)

    const { closeConversation } = await import('../../src/modules/agent/service.js')
    await closeConversation(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId },
      conversationId,
    )

    const [linha] = await propostas(conversationId)
    expect(linha?.status).toBe('EXPIRED')
  })
})

describe('MOD-AI-05 — fora do horário', () => {
  it('AC-04: a conversa entra na fila com a marca de fora de expediente', async () => {
    await enableAgent(tenant, janelaFechada())
    installFakeModel()

    const conversationId = await givenInbound('oi, tem horário amanhã?')
    await answer(tenant.tenantId, conversationId)

    const row = await conversa(conversationId)
    expect(row.status).toBe('HANDOFF')
    // E não `DISABLED`: a recepção precisa saber que é só horário.
    expect(row.handoffReason).toBe('OUT_OF_HOURS')
    expect(agendados.ids).toContain(conversationId)
  })
})
