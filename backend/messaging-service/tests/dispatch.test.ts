import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { dispatchTenant } from '../src/modules/messaging/dispatch.js'
import {
  asAdmin,
  asService,
  callApi,
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  resetDatabase,
  resetPorts,
  type FakePort,
  type TenantFixture,
} from './harness.js'

/** MOD-CRM-03 — o worker: o que sai, o que espera, o que morre. */

let fixture: TenantFixture
let port: FakePort

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  fixture = await givenTenant()
  port = installFakeEmailPort()
})

afterAll(closeHarness)

async function enqueue(tutorId: string, overrides: Record<string, unknown> = {}) {
  const response = await callApi({
    ...asService(fixture),
    method: 'POST',
    url: '/v1/messages',
    payload: {
      tutorId,
      templateKey: 'appointment_reminder',
      dedupeKey: `reminder:${tutorId}:${Math.random()}`,
      variables: { 'pets.lista': 'Thor', 'agendamento.data': 'quinta', 'agendamento.hora': '09:00' },
      ...overrides,
    },
  })
  return response.json().id as string
}

function readMessage(id: string) {
  return withTenant(fixture.tenantId, (tx) => tx.message.findUniqueOrThrow({ where: { id } }))
}

describe('despacho', () => {
  it('envia a mensagem e registra a trilha de entrega (AC-01)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    const summary = await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(summary.sent).toBe(1)
    expect(port.sent).toHaveLength(1)
    expect(port.sent[0]!.body).toContain('Thor')

    const message = await readMessage(id)
    expect(message.status).toBe('SENT')
    expect(message.sentAt).not.toBeNull()
    expect(message.providerMessageId).toBe('fake-1')

    const events = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findMany({ where: { messageId: id } }),
    )
    expect(events.map((event) => event.event)).toEqual(['SENT'])
  })

  it('não envia nada quando o motor está desligado', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    await enqueue(tutorId)

    await withTenant(fixture.tenantId, (tx) =>
      tx.messagingSettings.update({
        where: { tenantId: fixture.tenantId },
        data: { enabled: false },
      }),
    )

    const summary = await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(summary.picked).toBe(0)
    expect(port.sent).toHaveLength(0)
  })

  it('devolve à fila com backoff quando a falha é transitória (AC-05)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    port.failNext({ permanent: false })
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const message = await readMessage(id)
    expect(message.status).toBe('QUEUED')
    expect(message.attempts).toBe(1)
    // Um minuto de backoff na primeira tentativa: a mensagem volta, mas não já.
    expect(message.scheduledFor!.getTime()).toBeGreaterThan(Date.now())
  })

  it('mata na primeira falha permanente e suprime o endereço', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { email: 'quebrado@exemplo.com' })
    const id = await enqueue(tutorId)

    port.failNext({ permanent: true, errorCode: 'HTTP_422' })
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const message = await readMessage(id)
    // Endereço inválido continua inválido na quinta tentativa; insistir só queima a
    // reputação do domínio de envio.
    expect(message.status).toBe('DEAD')
    expect(message.errorCode).toBe('HTTP_422')

    const suppressions = await withTenant(fixture.tenantId, (tx) =>
      tx.messagingSuppression.findMany(),
    )
    expect(suppressions).toHaveLength(1)
    expect(suppressions[0]!.reason).toBe('HARD_BOUNCE')
  })

  it('revalida o consentimento no despacho, não só no enfileiramento (RN-03)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { marketing: { email: true } })
    // Uma mensagem de marketing entra liberada…
    const id = await enqueue(tutorId, {
      templateKey: 'appointment_reminder',
      dedupeKey: `mkt:${tutorId}`,
    })

    // …e o tutor pede para parar enquanto ela espera na fila.
    await withTenant(fixture.tenantId, (tx) =>
      tx.message.update({ where: { id }, data: { category: 'MARKETING' } }),
    )
    await withTenant(fixture.tenantId, (tx) =>
      tx.tutorConsent.create({
        data: {
          tenantId: fixture.tenantId,
          tutorId,
          channel: 'EMAIL',
          granted: false,
          purpose: 'MARKETING',
          version: '1.0',
          source: 'STAFF_FORM',
        },
      }),
    )

    await dispatchTenant(fixture.tenantId, { jitter: false })

    const message = await readMessage(id)
    expect(message.status).toBe('BLOCKED')
    expect(message.blockReason).toBe('NO_CONSENT')
    expect(port.sent).toHaveLength(0)
  })

  it('reenvia mensagem morta zerando o contador (AC-02 de MOD-CRM-11)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    port.failNext({ permanent: true })
    await dispatchTenant(fixture.tenantId, { jitter: false })
    expect((await readMessage(id)).status).toBe('DEAD')

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/messages/${id}/retry`,
    })

    expect(response.statusCode).toBe(204)
    const message = await readMessage(id)
    expect(message.status).toBe('QUEUED')
    expect(message.attempts).toBe(0)
  })
})

describe('janela de silêncio (RN-04)', () => {
  it('agenda para a abertura seguinte em vez de descartar (AC-03)', async () => {
    // Janela de um minuto que já passou hoje: tudo o que entrar agora espera amanhã.
    await enableMessaging(fixture, { quietStartMin: 0, quietEndMin: 1 })
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    const message = await readMessage(id)
    expect(message.status).toBe('SCHEDULED')
    expect(message.scheduledFor).not.toBeNull()
    expect(message.scheduledFor!.getTime()).toBeGreaterThan(Date.now())

    // E o worker não a pega antes da hora.
    const summary = await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(summary.picked).toBe(0)
    expect(port.sent).toHaveLength(0)
  })

  it('deixa a categoria OPERATIONAL atravessar a janela fechada', async () => {
    await enableMessaging(fixture, { quietStartMin: 0, quietEndMin: 1 })
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)

    // O aviso de taxi é sobre um pet que está na van agora — a exceção da RN-04.
    await withTenant(fixture.tenantId, (tx) =>
      tx.message.update({
        where: { id },
        data: { category: 'OPERATIONAL', status: 'QUEUED', scheduledFor: null },
      }),
    )

    const summary = await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(summary.sent).toBe(1)
  })
})

describe('invalidação por origem (AC-06)', () => {
  it('cancela o lembrete pendente quando a origem morre', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    const appointmentId = '11111111-1111-4111-8111-111111111111'
    const id = await enqueue(tutorId, {
      originType: 'APPOINTMENT',
      originId: appointmentId,
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    })

    const { cancelByOrigin } = await import('../src/modules/messaging/messages.js')
    const cancelled = await cancelByOrigin(fixture.tenantId, 'APPOINTMENT', appointmentId)

    expect(cancelled).toBe(1)
    expect((await readMessage(id)).status).toBe('CANCELLED')

    const summary = await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(summary.picked).toBe(0)
  })
})

describe('trilha de entrega', () => {
  it('recusa alteração em message_events (append-only)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    const id = await enqueue(tutorId)
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const event = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findFirstOrThrow({ where: { messageId: id } }),
    )

    // É a prova de entrega: uma linha editável não prova nada.
    await expect(
      withTenant(fixture.tenantId, (tx) =>
        tx.messageEvent.update({ where: { id: event.id }, data: { event: 'READ' } }),
      ),
    ).rejects.toThrow(/append-only/)
  })
})
