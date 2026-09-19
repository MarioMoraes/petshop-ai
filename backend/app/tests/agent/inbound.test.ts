import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callWebhook,
  closeHarness,
  givenTenant,
  givenTutor,
  givenWhatsapp,
  hashPhone,
  installFakeMessaging,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  upsertPayload,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-AI-01 e MOD-AI-02 — a mensagem que chega vira conversa.
 *
 * Todo teste daqui entra pelo **webhook**, e não pela função interna: o que a fatia
 * promete é que o `messages.upsert` da Evolution — que o produto descartava em silêncio
 * desde o MOD-CRM-01 — passe a produzir uma linha, uma conversa e uma pendência para a
 * recepção. Chamar `handleInbound` direto pularia a tradução do payload, que é metade do
 * que pode quebrar.
 */

let tenant: TenantFixture
let token: string

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  installFakeMessaging()
  tenant = await givenTenant()
  token = await givenWhatsapp(tenant)
})

afterAll(async () => {
  await closeHarness()
})

async function conversations(fixture: TenantFixture) {
  return ownerPrisma.agentConversation.findMany({
    where: { tenantId: fixture.tenantId },
    orderBy: { createdAt: 'asc' },
  })
}

async function turnsOf(conversationId: string) {
  return ownerPrisma.agentTurn.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  })
}

describe('MOD-AI-01 — recepção de mensagem', () => {
  it('AC-01: mensagem de número com ficha vira linha INBOUND, conversa e turno', async () => {
    const tutorId = await givenTutor(tenant)

    const response = await callWebhook(token, upsertPayload({ text: 'que horas é o banho?' }))
    expect(response.statusCode).toBe(204)

    const messages = await ownerPrisma.message.findMany({ where: { tenantId: tenant.tenantId } })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.direction).toBe('INBOUND')
    expect(messages[0]?.channel).toBe('WHATSAPP')
    expect(messages[0]?.tutorId).toBe(tutorId)
    expect(messages[0]?.toHash).toBe(hashPhone('+5511987654321'))

    const [conversa] = await conversations(tenant)
    expect(conversa?.tutorId).toBe(tutorId)
    expect(conversa?.turnCount).toBe(1)

    const turnos = await turnsOf(conversa!.id)
    expect(turnos).toHaveLength(1)
    expect(turnos[0]?.role).toBe('TUTOR')
    expect(turnos[0]?.messageId).toBe(messages[0]?.id)
  })

  it('sem agente ligado, a conversa nasce e vai direto para a fila da recepção', async () => {
    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({}))

    const [conversa] = await conversations(tenant)
    // AC-02 de MOD-AI-07: o inbox funciona mesmo com o atendimento automático desligado.
    expect(conversa?.status).toBe('HANDOFF')
    expect(conversa?.handoffReason).toBe('DISABLED')
    expect(conversa?.handoffAt).not.toBeNull()
  })

  it('com a conta suspensa, o agente cala como se estivesse desligado', async () => {
    const { enableAgent, installFakeModel } = await import('./fixtures.js')
    await enableAgent(tenant)
    installFakeModel()
    await givenTutor(tenant)

    /**
     * A conta parou entre ligar o agente e a mensagem chegar. É o mesmo desenho do plano
     * que desce: a linha de `agent_settings` fica como está — pagar religa sem
     * reconfigurar nada —, e o efetivo é o que responde.
     */
    await ownerPrisma.tenant.update({
      where: { id: tenant.tenantId },
      data: { status: 'SUSPENDED' },
    })

    await callWebhook(token, upsertPayload({}))

    const [conversa] = await conversations(tenant)
    // A mensagem do cliente continua entrando e continua visível: o inbox é o que sobra
    // de pé, e quem responde é gente.
    expect(conversa?.status).toBe('HANDOFF')
    expect(conversa?.handoffReason).toBe('DISABLED')
  })

  it('AC-02: número sem ficha grava a linha, não tem dono e vai para a recepção', async () => {
    await callWebhook(token, upsertPayload({ phone: '+5511911112222' }))

    const messages = await ownerPrisma.message.findMany({ where: { tenantId: tenant.tenantId } })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.tutorId).toBeNull()

    const [conversa] = await conversations(tenant)
    expect(conversa?.tutorId).toBeNull()
    expect(conversa?.handoffReason).toBe('UNKNOWN_NUMBER')
  })

  it('AC-03: o mesmo telefone em duas fichas não se desempata sozinho', async () => {
    await givenTutor(tenant, { name: 'Ana Souza' })
    await givenTutor(tenant, { name: 'Carlos Souza' })

    await callWebhook(token, upsertPayload({}))

    const [conversa] = await conversations(tenant)
    expect(conversa?.tutorId).toBeNull()
    expect(conversa?.handoffReason).toBe('AMBIGUOUS')

    // E a mensagem também não é atribuída a nenhuma das duas.
    const messages = await ownerPrisma.message.findMany({ where: { tenantId: tenant.tenantId } })
    expect(messages[0]?.tutorId).toBeNull()
  })

  it('AC-04: a reentrega do mesmo providerMessageId não duplica nada', async () => {
    await givenTutor(tenant)
    const payload = upsertPayload({ id: 'evo-repetido' })

    const primeira = await callWebhook(token, payload)
    const segunda = await callWebhook(token, payload)

    expect(primeira.statusCode).toBe(204)
    // 204 também na segunda: a Evolution reenvia para sempre o que não recebe 2xx.
    expect(segunda.statusCode).toBe(204)

    const messages = await ownerPrisma.message.findMany({ where: { tenantId: tenant.tenantId } })
    expect(messages).toHaveLength(1)

    const todas = await conversations(tenant)
    expect(todas).toHaveLength(1)
    expect(await turnsOf(todas[0]!.id)).toHaveLength(1)
    expect(todas[0]?.turnCount).toBe(1)
  })

  it('AC-05: áudio guarda o tipo e não o conteúdo', async () => {
    await givenTutor(tenant)

    await callWebhook(
      token,
      upsertPayload({ messageType: 'audioMessage', message: { audioMessage: { url: 'x' } } }),
    )

    const [conversa] = await conversations(tenant)
    expect(conversa?.handoffReason).toBe('MEDIA')

    const turnos = await turnsOf(conversa!.id)
    expect(turnos[0]?.kind).toBe('AUDIO')
    // O corpo cifrado existe, mas o que ele guarda é vazio: não há o que transcrever aqui.
    expect(turnos[0]?.contentEncrypted).toBeTruthy()
  })

  it('o eco da própria mensagem enviada é descartado', async () => {
    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ fromMe: true }))

    expect(await ownerPrisma.message.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
    expect(await conversations(tenant)).toHaveLength(0)
  })

  it('mensagem de grupo não é conversa com cliente', async () => {
    await callWebhook(token, upsertPayload({ jid: '120363000000000000@g.us' }))
    expect(await conversations(tenant)).toHaveLength(0)
  })

  it('o número sem o nono dígito casa com a ficha que o tem', async () => {
    const tutorId = await givenTutor(tenant, { phone: '+5511987654321' })

    // É assim que o WhatsApp entrega linha antiga: o jid vem sem o 9.
    await callWebhook(token, upsertPayload({ jid: '551187654321@s.whatsapp.net' }))

    const [conversa] = await conversations(tenant)
    expect(conversa?.tutorId).toBe(tutorId)
  })

  it('webhook com token desconhecido não escreve nada', async () => {
    const response = await callWebhook('token-que-nao-existe', upsertPayload({}))
    expect(response.statusCode).toBe(401)
    expect(await conversations(tenant)).toHaveLength(0)
  })
})

describe('MOD-AI-02 — conversa e contexto', () => {
  it('AC-01: a segunda mensagem entra na mesma conversa', async () => {
    await givenTutor(tenant)

    await callWebhook(token, upsertPayload({ text: 'oi' }))
    await callWebhook(token, upsertPayload({ text: 'ainda está aí?' }))

    const todas = await conversations(tenant)
    expect(todas).toHaveLength(1)
    expect(todas[0]?.turnCount).toBe(2)
    expect(await turnsOf(todas[0]!.id)).toHaveLength(2)
  })

  it('AC-05 de MOD-AI-05: depois do handoff a conversa recebe turno e não volta a ACTIVE', async () => {
    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ text: 'oi' }))
    await callWebhook(token, upsertPayload({ text: 'alô?' }))

    const [conversa] = await conversations(tenant)
    expect(conversa?.status).toBe('HANDOFF')
    // O motivo é o do primeiro handoff: o segundo turno não o reescreve.
    expect(conversa?.handoffReason).toBe('DISABLED')
  })

  it('AC-02: a conversa calada há mais de duas horas fecha e outra nasce', async () => {
    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ text: 'oi' }))

    const [primeira] = await conversations(tenant)
    // Devolve a conversa ao estado que o agente deixaria: viva, esperando resposta do
    // tutor. Sem o modelo, nenhuma chega aqui sozinha.
    await ownerPrisma.agentConversation.update({
      where: { id: primeira!.id },
      data: {
        status: 'ACTIVE',
        handoffReason: null,
        handoffAt: null,
        lastTurnAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    })

    await callWebhook(token, upsertPayload({ text: 'sim' }))

    const todas = await conversations(tenant)
    expect(todas).toHaveLength(2)
    expect(todas[0]?.status).toBe('CLOSED')
    expect(todas[1]?.turnCount).toBe(1)
  })

  it('a ficha cadastrada depois entra na conversa que já existia', async () => {
    await callWebhook(token, upsertPayload({ text: 'bom dia' }))
    const [antes] = await conversations(tenant)
    expect(antes?.tutorId).toBeNull()

    const tutorId = await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ text: 'sou eu de novo' }))

    const todas = await conversations(tenant)
    expect(todas).toHaveLength(1)
    expect(todas[0]?.tutorId).toBe(tutorId)
  })

  it('cada tenant só enxerga a própria conversa', async () => {
    const outro = await givenTenant('Outro Petshop')
    const tokenOutro = await givenWhatsapp(outro)

    await givenTutor(tenant)
    await callWebhook(token, upsertPayload({ text: 'do primeiro' }))
    await callWebhook(tokenOutro, upsertPayload({ text: 'do segundo' }))

    expect(await conversations(tenant)).toHaveLength(1)
    expect(await conversations(outro)).toHaveLength(1)
  })
})
