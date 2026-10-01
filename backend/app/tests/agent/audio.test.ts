import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_HANDOFF_SAY } from '@petshop/shared-types'
import {
  callAsStaff,
  callWebhook,
  captureScheduledTurns,
  closeHarness,
  enableAgent,
  enableMessaging,
  givenTenant,
  givenTutor,
  givenWhatsapp,
  installFakeMessaging,
  installFakeModel,
  installFakePortal,
  installFakeTranscription,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  upsertPayload,
  type TenantFixture,
} from './fixtures.js'

const { answer } = await import('../../src/modules/agent/runner.js')
const { LONG_AUDIO_WARNING, MEDIA_WARNING } = await import(
  '../../src/modules/agent/conversations.js'
)

/**
 * O agente ouvindo áudio — o Whisper da instalação transcreve, e o turno segue.
 *
 * O Whisper é dublado (`installFakeTranscription`), como o modelo: o que se prova aqui é
 * o caminho do lado de cá — quem decide que o áudio fica com o agente, quando a
 * transcrição roda, onde o texto é gravado e para onde vai a conversa quando ela falha.
 */

let tenant: TenantFixture
let token: string
let motor: ReturnType<typeof installFakeMessaging>

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  motor = installFakeMessaging()
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

async function givenAudio(seconds: number | null = 12): Promise<string> {
  await callWebhook(
    token,
    upsertPayload({
      messageType: 'audioMessage',
      message: { audioMessage: { url: 'x', ...(seconds === null ? {} : { seconds }) } },
    }),
  )
  const conversation = await ownerPrisma.agentConversation.findFirstOrThrow({
    where: { tenantId: tenant.tenantId },
    orderBy: { createdAt: 'desc' },
  })
  return conversation.id
}

async function conversa(id: string) {
  return ownerPrisma.agentConversation.findUniqueOrThrow({ where: { id } })
}

describe('MOD-AI-01 AC-05 — o áudio que o agente ouve', () => {
  it('transcreve, entrega ao modelo marcado como áudio e responde', async () => {
    installFakePortal()
    const whisper = installFakeTranscription('quero marcar um banho pro Thor amanhã')
    const modelo = installFakeModel({ reply: 'Claro! Que horário prefere?' })

    const id = await givenAudio()
    // A conversa fica com o agente: nada de handoff no webhook.
    expect((await conversa(id)).status).toBe('ACTIVE')
    expect(whisper.calls).toHaveLength(0)

    await answer(tenant.tenantId, id)

    expect(whisper.calls).toEqual([{ bytes: 4, mimetype: 'audio/ogg; codecs=opus' }])
    const ultima = modelo.calls[0]?.messages.at(-1)
    expect(ultima?.content).toContain('[áudio transcrito] quero marcar um banho pro Thor amanhã')
    expect(motor.sent.at(-1)?.text).toContain('Que horário prefere?')
    expect((await conversa(id)).status).toBe('ACTIVE')

    // A linha de `messages` continua sem o conteúdo (AC-05); a transcrição é do turno.
    const mensagem = await ownerPrisma.message.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, direction: 'INBOUND' },
    })
    expect(mensagem.templateKey).toBe('inbound')

    // A recepção vê que aquilo é transcrição.
    const detalhe = await callAsStaff(tenant, { method: 'GET', url: `/v1/agent/conversations/${id}` })
    expect(detalhe.statusCode).toBe(200)
    expect(detalhe.json().turns[0].content).toBe(
      '(áudio) quero marcar um banho pro Thor amanhã',
    )
  })

  it('o varredor que reassume não transcreve o mesmo áudio duas vezes', async () => {
    installFakePortal()
    const whisper = installFakeTranscription('oi, tudo bem?')
    installFakeModel({ reply: 'Tudo ótimo!' }, { reply: 'Posso ajudar em mais algo?' })

    const id = await givenAudio()
    await answer(tenant.tenantId, id)
    await callWebhook(token, upsertPayload({ text: 'e o preço do banho?' }))
    await answer(tenant.tenantId, id)

    expect(whisper.calls).toHaveLength(1)
  })

  it('sem Whisper, o áudio vai para a recepção como antes', async () => {
    const id = await givenAudio()

    const row = await conversa(id)
    expect(row.status).toBe('HANDOFF')
    expect(row.handoffReason).toBe('MEDIA')
    expect(motor.sent.at(-1)?.text).toBe(MEDIA_WARNING)
  })

  it('o áudio acima do teto vai para a recepção com frase própria', async () => {
    const whisper = installFakeTranscription('nunca chamado')

    const id = await givenAudio(121)

    expect((await conversa(id)).handoffReason).toBe('MEDIA')
    expect(motor.sent.at(-1)?.text).toBe(LONG_AUDIO_WARNING)
    expect(whisper.calls).toHaveLength(0)
  })

  it('o Whisper fora do ar manda para a recepção, e o cliente sabe por quê', async () => {
    installFakePortal()
    installFakeTranscription(new Error('ECONNREFUSED'))
    const modelo = installFakeModel()

    const id = await givenAudio()
    await answer(tenant.tenantId, id)

    const row = await conversa(id)
    expect(row.status).toBe('HANDOFF')
    expect(row.handoffReason).toBe('MEDIA')
    expect(motor.sent.at(-1)?.text).toBe(AGENT_HANDOFF_SAY.UNHEARD)
    expect(modelo.calls).toHaveLength(0)
  })

  it('a mídia que o provedor já descartou vai para a recepção', async () => {
    installFakePortal()
    installFakeTranscription('não deveria ser chamado')
    installFakeModel()
    motor.loseNextAudio()

    const id = await givenAudio()
    await answer(tenant.tenantId, id)

    expect((await conversa(id)).handoffReason).toBe('MEDIA')
  })

  it('áudio sem fala reconhecível vai para a recepção', async () => {
    installFakePortal()
    installFakeTranscription('')
    const modelo = installFakeModel()

    const id = await givenAudio()
    await answer(tenant.tenantId, id)

    expect((await conversa(id)).handoffReason).toBe('MEDIA')
    expect(modelo.calls).toHaveLength(0)
  })

  it('a configuração diz à tela se os áudios são ouvidos', async () => {
    installFakeTranscription('x')
    const ligado = await callAsStaff(tenant, { method: 'GET', url: '/v1/agent/settings' })
    expect(ligado.json().audioTranscription).toBe(true)

    installFakeTranscription(null)
    const desligado = await callAsStaff(tenant, { method: 'GET', url: '/v1/agent/settings' })
    expect(desligado.json().audioTranscription).toBe(false)
  })
})
