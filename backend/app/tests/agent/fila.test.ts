import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asReceptionist,
  asRole,
  callApi,
  callWebhook,
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  givenWhatsapp,
  installFakeMessaging,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  upsertPayload,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-AI-06 — a fila de atendimento.
 *
 * A tela onde a recepção vê o que chegou e responde. Todo cenário nasce de uma mensagem
 * **de verdade**, entrando pelo webhook: montar a conversa com um `create` direto testaria
 * a fila contra um estado que nenhum caminho do produto produz.
 */

let tenant: TenantFixture
let motor: ReturnType<typeof installFakeMessaging>
let token: string

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  motor = installFakeMessaging()
  tenant = await givenTenant()
  token = await givenWhatsapp(tenant)
  await enableMessaging(tenant)
})

afterAll(async () => {
  await closeHarness()
})

/** Uma conversa na fila, com o tutor já cadastrado. */
async function givenConversation(options: { phone?: string; text?: string } = {}) {
  const tutorId = await givenTutor(tenant, options.phone ? { phone: options.phone } : {})
  await callWebhook(token, upsertPayload(options))
  const conversation = await ownerPrisma.agentConversation.findFirstOrThrow({
    where: { tenantId: tenant.tenantId },
    orderBy: { createdAt: 'desc' },
  })
  return { tutorId, id: conversation.id }
}

describe('MOD-AI-06 — a fila', () => {
  it('AC-01: a fila mostra tutor, motivo, espera e a última mensagem', async () => {
    await givenConversation({ text: 'meu cachorro pode ir amanhã?' })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/agent/conversations?status=HANDOFF',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.total).toBe(1)
    expect(body.data[0].tutorName).toBe('Ana Souza')
    expect(body.data[0].handoffReason).toBe('DISABLED')
    expect(body.data[0].lastMessage).toBe('meu cachorro pode ir amanhã?')
    expect(body.data[0].waitingMinutes).toBe(0)
    // Com ficha, o número sai mascarado: ele está a um clique na tela do tutor.
    expect(body.data[0].contact).toBe('(11) *****-4321')
  })

  it('o número sem ficha aparece inteiro, porque não há outro lugar de onde tirá-lo', async () => {
    await callWebhook(token, upsertPayload({ phone: '+5511911112222' }))

    const body = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/agent/conversations' })
    ).json()

    expect(body.data[0].tutorId).toBeNull()
    expect(body.data[0].contact).toBe('+5511911112222')
    expect(body.data[0].handoffReason).toBe('UNKNOWN_NUMBER')
  })

  it('a fila devolve quem espera há mais tempo primeiro', async () => {
    const antiga = await givenConversation({ phone: '+5511911110001', text: 'primeira' })
    await givenConversation({ phone: '+5511911110002', text: 'segunda' })

    await ownerPrisma.agentConversation.update({
      where: { id: antiga.id },
      data: { lastTurnAt: new Date(Date.now() - 30 * 60_000) },
    })

    const body = (
      await callApi({
        ...asAdmin(tenant),
        method: 'GET',
        url: '/v1/agent/conversations?status=HANDOFF',
      })
    ).json()

    expect(body.data[0].id).toBe(antiga.id)
    expect(body.data[0].waitingMinutes).toBeGreaterThanOrEqual(29)
  })

  it('AC-04: o filtro de espera é o que o sino da topbar conta', async () => {
    const antiga = await givenConversation({ phone: '+5511911110001' })
    await givenConversation({ phone: '+5511911110002' })

    await ownerPrisma.agentConversation.update({
      where: { id: antiga.id },
      data: { lastTurnAt: new Date(Date.now() - 30 * 60_000) },
    })

    const body = (
      await callApi({
        ...asAdmin(tenant),
        method: 'GET',
        url: '/v1/agent/conversations?status=HANDOFF&waitingOverMinutes=10&limit=1',
      })
    ).json()

    // O total é do banco, e não da página: é o número que o sino exibe.
    expect(body.total).toBe(1)
  })

  it('AC-02: assumir tira a conversa da fila dos outros', async () => {
    const { id } = await givenConversation()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${id}/assign`,
    })
    expect(response.statusCode).toBe(204)

    const conversa = await ownerPrisma.agentConversation.findUniqueOrThrow({ where: { id } })
    expect(conversa.status).toBe('ASSIGNED')
    expect(conversa.assignedTo).toBe(tenant.userId)
  })

  it('AC-02: assumir o que já é de outra pessoa é recusado', async () => {
    const { id } = await givenConversation()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${id}/assign`,
    })

    const outro = await asReceptionist(tenant)
    const response = await callApi({
      ...outro,
      method: 'POST',
      url: `/v1/agent/conversations/${id}/assign`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_AI_004')
  })

  it('assumir de novo a própria conversa não é erro', async () => {
    const { id } = await givenConversation()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${id}/assign`,
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${id}/assign`,
    })
    expect(response.statusCode).toBe(204)
  })

  it('AC-03: responder passa pelo motor, vira turno e assume a conversa', async () => {
    const { id, tutorId } = await givenConversation()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${id}/reply`,
      payload: { text: 'amanhã às 9h está livre' },
    })
    expect(response.statusCode).toBe(204)

    expect(motor.sent).toHaveLength(1)
    expect(motor.sent[0]).toMatchObject({ tutorId, conversationId: id })

    const turnos = await ownerPrisma.agentTurn.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    })
    expect(turnos).toHaveLength(2)
    expect(turnos[1]?.role).toBe('STAFF')
    expect(turnos[1]?.authorId).toBe(tenant.userId)

    const conversa = await ownerPrisma.agentConversation.findUniqueOrThrow({ where: { id } })
    expect(conversa.status).toBe('ASSIGNED')
    expect(conversa.assignedTo).toBe(tenant.userId)
    expect(conversa.turnCount).toBe(2)
  })

  it('a resposta que o motor recusa não vira turno na conversa', async () => {
    const { id } = await givenConversation()
    motor.failNext()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${id}/reply`,
      payload: { text: 'vai falhar' },
    })

    expect(response.statusCode).toBe(500)
    // O que a recepção vê na tela continua sendo só a mensagem do cliente.
    expect(await ownerPrisma.agentTurn.count({ where: { conversationId: id } })).toBe(1)
  })

  it('sem ficha não há resposta pela tela, e a recusa diz o que fazer', async () => {
    await callWebhook(token, upsertPayload({ phone: '+5511911112222' }))
    const conversa = await ownerPrisma.agentConversation.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })

    const detalhe = (
      await callApi({
        ...asAdmin(tenant),
        method: 'GET',
        url: `/v1/agent/conversations/${conversa.id}`,
      })
    ).json()
    expect(detalhe.canReply).toBe(false)
    expect(detalhe.replyBlockedReason).toContain('Cadastre o tutor')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${conversa.id}/reply`,
      payload: { text: 'oi' },
    })
    expect(response.statusCode).toBe(409)
    expect(motor.sent).toHaveLength(0)
  })

  it('o detalhe do número ambíguo traz as duas fichas', async () => {
    await givenTutor(tenant, { name: 'Ana Souza' })
    await givenTutor(tenant, { name: 'Carlos Souza' })
    await callWebhook(token, upsertPayload({}))

    const conversa = await ownerPrisma.agentConversation.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    const detalhe = (
      await callApi({
        ...asAdmin(tenant),
        method: 'GET',
        url: `/v1/agent/conversations/${conversa.id}`,
      })
    ).json()

    expect(detalhe.handoffReason).toBe('AMBIGUOUS')
    expect(detalhe.candidates.map((c: { name: string }) => c.name).sort()).toEqual([
      'Ana Souza',
      'Carlos Souza',
    ])
  })

  it('encerrar fecha a conversa, e depois disso não se responde mais', async () => {
    const { id } = await givenConversation()

    expect(
      (
        await callApi({
          ...asAdmin(tenant),
          method: 'POST',
          url: `/v1/agent/conversations/${id}/close`,
        })
      ).statusCode,
    ).toBe(204)

    const conversa = await ownerPrisma.agentConversation.findUniqueOrThrow({ where: { id } })
    expect(conversa.status).toBe('CLOSED')
    expect(conversa.closedAt).not.toBeNull()

    const resposta = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/agent/conversations/${id}/reply`,
      payload: { text: 'tarde demais' },
    })
    expect(resposta.statusCode).toBe(409)
  })

  it('conversa de outro estabelecimento é 404, e não 403', async () => {
    const { id } = await givenConversation()
    const outro = await givenTenant('Outro Petshop')

    const response = await callApi({
      ...asAdmin(outro),
      method: 'GET',
      url: `/v1/agent/conversations/${id}`,
    })
    expect(response.statusCode).toBe(404)
  })

  it('id que não é UUID é 404, e não 500', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/agent/conversations/nao-e-uuid',
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('MOD-AI §9 — quem atende', () => {
  it('a recepção vê a fila e responde', async () => {
    const { id } = await givenConversation()
    const recepcao = await asReceptionist(tenant)

    expect(
      (await callApi({ ...recepcao, method: 'GET', url: '/v1/agent/conversations' })).statusCode,
    ).toBe(200)

    const resposta = await callApi({
      ...recepcao,
      method: 'POST',
      url: `/v1/agent/conversations/${id}/reply`,
      payload: { text: 'claro, pode trazer' },
    })
    expect(resposta.statusCode).toBe(204)
    expect(motor.sent).toHaveLength(1)
  })

  it('quem tosa não vê a fila de atendimento', async () => {
    await givenConversation()
    const tosador = await asRole(tenant, 'GROOMER')

    const response = await callApi({ ...tosador, method: 'GET', url: '/v1/agent/conversations' })
    expect(response.statusCode).toBe(403)
  })
})
