import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  FAKE_IDS,
  FAKE_SLOT,
  asAdmin,
  asRole,
  callApi,
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
  upsertPayload,
  type TenantFixture,
} from './fixtures.js'

const { answer } = await import('../../src/modules/agent/runner.js')
const { closeConversation } = await import('../../src/modules/agent/service.js')

/**
 * MOD-AI-09 — o painel de qualidade.
 *
 * O painel conta **desfechos**, e é a única coisa que ele conta: conversa encerrada sem
 * passar por gente é resolvida; com handoff, não. O que a suíte prova é que nenhuma
 * definição mais generosa se infiltrou — nem a do modelo achando que resolveu, nem a
 * exclusão dos handoffs que "não são culpa do agente".
 *
 * Todo cenário entra pelo webhook e termina com a conversa **fechada**, porque é assim
 * que uma linha entra na conta.
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
})

afterAll(async () => {
  await closeHarness()
})

async function stats(caller = asAdmin(tenant)) {
  const response = await callApi({ ...caller, method: 'GET', url: '/v1/agent/stats' })
  return { status: response.statusCode, body: response.json() }
}

/** Uma conversa que o agente respondeu, e que termina fechada. */
async function conversaRespondida(
  options: {
    handoff?: boolean
    text?: string
    usage?: { inputTokens: number; outputTokens: number }
  } = {},
) {
  const phone = `+5511${Math.floor(100_000_000 + Math.random() * 899_999_999)}`
  await givenTutor(tenant, { phone })
  installFakeModel({
    reply: 'Claro!',
    handoff: options.handoff ?? false,
    ...(options.usage
      ? { usage: { ...options.usage, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      : {}),
  })

  await callWebhook(token, upsertPayload({ phone, text: options.text ?? 'oi' }))
  const conversa = await ownerPrisma.agentConversation.findFirstOrThrow({
    where: { tenantId: tenant.tenantId },
    orderBy: { createdAt: 'desc' },
  })

  await answer(tenant.tenantId, conversa.id)
  await closeConversation({ tenantId: tenant.tenantId, actorUserId: tenant.userId }, conversa.id)
  return conversa.id
}

describe('MOD-AI-09 — a taxa de resolução', () => {
  it('AC-01 e AC-02: resolvida é a que terminou sem passar por gente', async () => {
    installFakePortal()
    await conversaRespondida()
    await conversaRespondida()
    await conversaRespondida({ handoff: true })

    const { status, body } = await stats()

    expect(status).toBe(200)
    expect(body.conversations).toBe(3)
    expect(body.resolved).toBe(2)
    expect(body.resolutionRate).toBeCloseTo(66.7, 1)
    expect(body.handoffs).toEqual([{ reason: 'REQUESTED', total: 1 }])
  })

  it('o handoff que o agente não causou conta na taxa, e aparece no motivo', async () => {
    installFakePortal()
    await conversaRespondida()

    // Número sem ficha: a conversa nunca foi do agente e vai direto para a fila. Contá-la
    // como resolvida seria o agente se dando nota por trabalho que não fez; excluí-la da
    // conta seria ele corrigindo a própria prova. Ela fica, e o motivo explica.
    await callWebhook(token, upsertPayload({ phone: '+5511900000000', text: 'oi' }))
    const desconhecida = await ownerPrisma.agentConversation.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, tutorId: null },
    })
    await closeConversation(
      { tenantId: tenant.tenantId, actorUserId: tenant.userId },
      desconhecida.id,
    )

    const { body } = await stats()

    expect(body.conversations).toBe(2)
    expect(body.resolutionRate).toBe(50)
    expect(body.handoffs).toEqual([{ reason: 'UNKNOWN_NUMBER', total: 1 }])
  })

  it('conversa ainda aberta não entra na conta: ela não tem desfecho', async () => {
    installFakePortal()
    installFakeModel({ reply: 'Claro!' })
    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ text: 'oi' }))
    const conversa = await ownerPrisma.agentConversation.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    await answer(tenant.tenantId, conversa.id)

    const { body } = await stats()

    expect(body.conversations).toBe(0)
    expect(body.resolutionRate).toBe(0)
    // Mas o turno já custou, e o gasto é do dia em que aconteceu.
    expect(body.turns).toBe(1)
    expect(body.costMillicents).toBeGreaterThan(0)
  })
})

describe('MOD-AI-09 — custo e tempo', () => {
  it('o custo aparece em milésimos de centavo, que é onde ele não é zero', async () => {
    installFakePortal()
    // Um turno curto de verdade: dez tokens de entrada e cinco de saída. É a ordem de
    // grandeza de "que horas é o banho?" respondido com o prefixo em cache.
    await conversaRespondida({ usage: { inputTokens: 10, outputTokens: 5 } })

    const { body } = await stats()

    // **Em centavos inteiros este número seria zero**, e o painel diria que o agente é de
    // graça — que é a mentira que a coluna `cost_millicents` existe para não contar.
    expect(body.costMillicents).toBeGreaterThan(0)
    expect(Math.round(body.costMillicents / 1000)).toBe(0)
    expect(body.avgCostMillicents).toBe(body.costMillicents)
  })

  it('o tempo médio de resposta é nulo quando o agente não respondeu nada', async () => {
    const { body } = await stats()

    expect(body.avgResponseSeconds).toBeNull()
    expect(body.turns).toBe(0)
  })

  it('o tempo médio sai do par mensagem do cliente → resposta do agente', async () => {
    installFakePortal()
    await conversaRespondida()

    const { body } = await stats()

    expect(body.avgResponseSeconds).not.toBeNull()
    expect(body.avgResponseSeconds).toBeGreaterThanOrEqual(0)
  })
})

describe('MOD-AI-09 — o funil das escritas', () => {
  it('conta a proposta pelo estado em que ela está hoje', async () => {
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
      { reply: 'Confirma?' },
    )

    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ text: 'marca banho' }))
    const conversa = await ownerPrisma.agentConversation.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    await answer(tenant.tenantId, conversa.id)

    const proposta = await stats()
    expect(proposta.body.writes).toMatchObject({ proposed: 1, confirmed: 0 })

    const viva = await ownerPrisma.agentToolCall.findFirstOrThrow({
      where: { conversationId: conversa.id, status: 'PROPOSED' },
    })
    installFakeModel(
      {
        tools: [
          { name: 'confirmarProposta', input: { confirmationToken: viva.confirmationToken } },
        ],
      },
      { reply: 'Marcado!' },
    )
    await callWebhook(token, upsertPayload({ text: 'sim' }))
    await answer(tenant.tenantId, conversa.id)

    const confirmada = await stats()
    expect(confirmada.body.writes).toMatchObject({ proposed: 0, confirmed: 1 })
  })

  it('a leitura não entra no funil: ele é das escritas', async () => {
    installFakePortal()
    installFakeModel({ tools: [{ name: 'listarMeusPets' }] }, { reply: 'Nenhum pet por aqui.' })

    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ text: 'meus pets?' }))
    const conversa = await ownerPrisma.agentConversation.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    await answer(tenant.tenantId, conversa.id)

    const { body } = await stats()
    expect(body.writes).toEqual({
      proposed: 0,
      confirmed: 0,
      superseded: 0,
      expired: 0,
      failed: 0,
    })
  })
})

describe('MOD-AI-09 — quem vê', () => {
  it('a recepção abre o painel: quem atende a fila é quem primeiro nota a queda', async () => {
    const recepcao = await asRole(tenant, 'RECEPTIONIST')
    const { status } = await stats(recepcao)
    expect(status).toBe(200)
  })

  it('quem não opera CRM não abre', async () => {
    const banhista = await asRole(tenant, 'BATHER')
    const { status } = await stats(banhista)
    expect(status).toBe(403)
  })

  it('um tenant não vê o painel do outro', async () => {
    installFakePortal()
    await conversaRespondida()

    const outro = await givenTenant('Outro Petshop')
    const { body } = await stats(asAdmin(outro))

    expect(body.conversations).toBe(0)
    expect(body.turns).toBe(0)
  })
})
