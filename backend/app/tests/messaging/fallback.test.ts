import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { dispatchTenant } from '../../src/modules/messaging/dispatch.js'
import {
  callAsStaff,
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  installFakeWhatsAppPort,
  resetDatabase,
  resetPorts,
  type FakePort,
  type TenantFixture,
} from './fixtures.js'

/**
 * O segundo canal (`fallbackToEmail`): a confirmação do agendamento online sai pelo
 * WhatsApp e, se ele não entregar, pelo e-mail.
 */

let fixture: TenantFixture
let email: FakePort
let whatsapp: FakePort

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  fixture = await givenTenant()
  email = installFakeEmailPort()
  whatsapp = installFakeWhatsAppPort()
  await enableMessaging(fixture)
})

afterAll(closeHarness)

const VARIABLES = {
  'pets.lista': 'Thor',
  'agendamento.servico': 'Banho',
  'agendamento.data': 'quinta',
  'agendamento.hora': '09:00',
  'agendamento.profissional': 'Bia',
}

async function enqueue(tutorId: string, overrides: Record<string, unknown> = {}) {
  const response = await callAsStaff(fixture, {
    method: 'POST',
    url: '/v1/messages',
    payload: {
      tutorId,
      templateKey: 'appointment_confirmed',
      dedupeKey: `confirmed:${tutorId}:${Math.random()}`,
      variables: VARIABLES,
      fallbackToEmail: true,
      ...overrides,
    },
  })
  expect(response.statusCode).toBeLessThan(300)
  return response.json().id as string
}

function readMessage(id: string) {
  return withTenant(fixture.tenantId, (tx) => tx.message.findUniqueOrThrow({ where: { id } }))
}

describe('segundo canal', () => {
  it('sai pelo WhatsApp quando ele entrega, e o texto do e-mail é apagado', async () => {
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    const pending = await readMessage(id)
    expect(pending.channel).toBe('WHATSAPP')
    expect(pending.fallbackBodyEncrypted).not.toBeNull()

    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(whatsapp.sent).toHaveLength(1)
    expect(email.sent).toHaveLength(0)
    const sent = await readMessage(id)
    expect(sent.status).toBe('SENT')
    expect(sent.fallbackBodyEncrypted).toBeNull()
    expect(sent.fallbackSubjectEncrypted).toBeNull()
  })

  it('cai para o e-mail na primeira falha do WhatsApp, com o texto do e-mail', async () => {
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    whatsapp.failNext()
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const moved = await readMessage(id)
    expect(moved.channel).toBe('EMAIL')
    expect(moved.status).toBe('QUEUED')
    expect(moved.attempts).toBe(0)

    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(email.sent).toHaveLength(1)
    // O texto é o do e-mail — com assunto próprio e o profissional, que o do WhatsApp
    // não traz —, e não o corpo do WhatsApp reaproveitado.
    expect(email.sent[0]!.subject).toContain('Agendamento confirmado')
    expect(email.sent[0]!.body).toContain('Profissional: Bia')
    expect((await readMessage(id)).status).toBe('SENT')

    const events = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findMany({ where: { messageId: id }, orderBy: { occurredAt: 'asc' } }),
    )
    expect(events.map((event) => event.event)).toEqual(['FAILED', 'SENT'])
    expect(events[0]!.raw).toMatchObject({ channel: 'WHATSAPP', fallbackTo: 'EMAIL' })
  })

  it('não espera o celular do petshop voltar: a queda de canal também cai para o e-mail', async () => {
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    whatsapp.failNext({ errorCode: 'CHANNEL_UNAVAILABLE' })
    await dispatchTenant(fixture.tenantId, { jitter: false })
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(email.sent).toHaveLength(1)
    expect((await readMessage(id)).channel).toBe('EMAIL')
  })

  it('número sem WhatsApp: cai para o e-mail e o número entra na supressão', async () => {
    const tutorId = await givenTutor(fixture)
    await enqueue(tutorId)

    whatsapp.failNext({ permanent: true, errorCode: 'NOT_ON_WHATSAPP' })
    await dispatchTenant(fixture.tenantId, { jitter: false })
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(email.sent).toHaveLength(1)
    const suppressions = await withTenant(fixture.tenantId, (tx) =>
      tx.messagingSuppression.count({ where: { channel: 'WHATSAPP' } }),
    )
    expect(suppressions).toBe(1)
  })

  it('sem e-mail na ficha, segue o caminho de sempre do WhatsApp', async () => {
    const tutorId = await givenTutor(fixture, { email: null })
    const id = await enqueue(tutorId)

    whatsapp.failNext()
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const message = await readMessage(id)
    expect(message.channel).toBe('WHATSAPP')
    expect(message.status).toBe('QUEUED')
    expect(message.attempts).toBe(1)
    expect(email.sent).toHaveLength(0)
  })

  it('sem o pedido, a falha do WhatsApp continua retentando no WhatsApp', async () => {
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId, { fallbackToEmail: undefined })

    expect((await readMessage(id)).fallbackBodyEncrypted).toBeNull()

    whatsapp.failNext()
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const message = await readMessage(id)
    expect(message.channel).toBe('WHATSAPP')
    expect(message.attempts).toBe(1)
    expect(email.sent).toHaveLength(0)
  })

  it('com o WhatsApp pedido pelo nome e fora do ar, já nasce no e-mail', async () => {
    resetPorts()
    email = installFakeEmailPort()
    whatsapp = installFakeWhatsAppPort({ available: false })

    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId, { channel: 'WHATSAPP' })

    const message = await readMessage(id)
    expect(message.status).toBe('QUEUED')
    expect(message.channel).toBe('EMAIL')
    expect(message.fallbackBodyEncrypted).toBeNull()
  })
})
