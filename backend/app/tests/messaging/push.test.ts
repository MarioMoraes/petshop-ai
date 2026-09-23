import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { dispatchTenant } from '../../src/modules/messaging/dispatch.js'
import { registerDevice } from '../../src/modules/messaging/devices.js'
import { suppress } from '../../src/modules/messaging/suppressions.js'
import { anonymizeTutor } from '../../src/modules/tutors/service.js'
import {
  setPushPort,
  type PushRequest,
  type PushResult,
} from '../../src/modules/messaging/ports/push.js'
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
 * O push que vai junto com a mensagem (etapa 9 do app do tutor).
 *
 * O que esta suíte guarda é o lugar do push **dentro** do motor: ele sai só da
 * mensagem que passou pelos portões do tutor, nunca se repete na retentativa, e nunca
 * muda o destino da mensagem principal. Os três defeitos são silenciosos — um push a
 * mais, um push de mensagem bloqueada, um lembrete mandado ao backoff por causa do FCM
 * — e nenhum outro teste do módulo os perceberia.
 */

let fixture: TenantFixture
let whatsapp: FakePort
let pushes: PushRequest[]
let respostas: PushResult[]

function installFakePush(available = true): void {
  pushes = []
  respostas = []
  setPushPort({
    isAvailable: () => available,
    async send(request) {
      pushes.push(request)
      return respostas.shift() ?? { ok: true, providerMessageId: `fcm-${pushes.length}` }
    },
  })
}

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  fixture = await givenTenant()
  installFakeEmailPort()
  whatsapp = installFakeWhatsAppPort()
  installFakePush()
  await enableMessaging(fixture)
})

afterEach(() => setPushPort(null))
afterAll(closeHarness)

const VARIABLES = {
  'pets.lista': 'Thor',
  'agendamento.servico': 'Banho',
  'agendamento.data': 'quinta',
  'agendamento.hora': '09:00',
  'agendamento.profissional': 'Bia',
}

async function enqueue(
  tutorId: string,
  templateKey = 'appointment_confirmed',
  variables: Record<string, string> = VARIABLES,
) {
  const response = await callAsStaff(fixture, {
    method: 'POST',
    url: '/v1/messages',
    payload: {
      tutorId,
      templateKey,
      dedupeKey: `${templateKey}:${tutorId}:${Math.random()}`,
      variables,
    },
  })
  expect(response.statusCode).toBeLessThan(300)
  return response.json().id as string
}

function readMessage(id: string) {
  return withTenant(fixture.tenantId, (tx) => tx.message.findUniqueOrThrow({ where: { id } }))
}

function deliveries(id: string) {
  return withTenant(fixture.tenantId, (tx) =>
    tx.pushDelivery.findMany({ where: { messageId: id }, orderBy: { sentAt: 'asc' } }),
  )
}

describe('o push junto com a mensagem', () => {
  it('sai para cada aparelho do tutor, com o texto renderizado e o destino no app', async () => {
    const tutorId = await givenTutor(fixture)
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-tablet-2-abcdefghijk', 'ANDROID')

    const id = await enqueue(tutorId)
    expect((await readMessage(id)).pushTitleEncrypted).not.toBeNull()

    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(whatsapp.sent).toHaveLength(1)
    expect(pushes.map((p) => p.token).sort()).toEqual([
      'token-do-celular-1-abcdefghij',
      'token-do-tablet-2-abcdefghijk',
    ])
    expect(pushes[0]).toMatchObject({
      title: 'Horário confirmado',
      body: 'Thor — quinta às 09:00 no Petshop Teste.',
      data: { abre: 'agendamento' },
    })
    expect(pushes[0]!.data.slug).toBeTruthy()

    expect(await deliveries(id)).toHaveLength(2)
    // O texto é dado pessoal e já saiu: some da linha.
    const sent = await readMessage(id)
    expect(sent.status).toBe('SENT')
    expect(sent.pushTitleEncrypted).toBeNull()
    expect(sent.pushBodyEncrypted).toBeNull()
  })

  it('não se repete quando o WhatsApp falha e a mensagem volta à fila', async () => {
    const tutorId = await givenTutor(fixture)
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')
    const id = await enqueue(tutorId)

    whatsapp.failNext()
    await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(pushes).toHaveLength(1)

    // A retentativa sai do backoff: força a hora para que o despacho a pegue agora.
    await withTenant(fixture.tenantId, (tx) =>
      tx.message.update({ where: { id }, data: { scheduledFor: new Date(0) } }),
    )
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(whatsapp.sent).toHaveLength(1)
    expect(pushes).toHaveLength(1)
    expect(await deliveries(id)).toHaveLength(1)
  })

  it('não sai de mensagem bloqueada no despacho', async () => {
    const tutorId = await givenTutor(fixture, { phone: '+5511911112222', email: null })
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')
    const id = await enqueue(tutorId)

    // O número entrou na supressão enquanto a mensagem esperava.
    await withTenant(fixture.tenantId, (tx) =>
      suppress(tx, fixture.tenantId, 'WHATSAPP', '+5511911112222', 'NOT_ON_WHATSAPP'),
    )
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect((await readMessage(id)).status).toBe('BLOCKED')
    expect(pushes).toHaveLength(0)
  })

  it('falha do FCM não muda a mensagem, e token morto revoga o aparelho', async () => {
    const tutorId = await givenTutor(fixture)
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')
    respostas.push({ ok: false, providerMessageId: null, invalidToken: true, errorCode: 'UNREGISTERED' })

    const id = await enqueue(tutorId)
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const sent = await readMessage(id)
    expect(sent.status).toBe('SENT')
    expect(sent.attempts).toBe(0)
    expect((await deliveries(id))[0]!.status).toBe('INVALID_TOKEN')

    const device = await withTenant(fixture.tenantId, (tx) => tx.pushDevice.findFirstOrThrow())
    expect(device.revokedAt).not.toBeNull()

    // O aparelho revogado não recebe o aviso seguinte.
    await enqueue(tutorId, 'appointment_reminder')
    await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(pushes).toHaveLength(1)
  })

  it('template sem texto de push não gera push', async () => {
    const tutorId = await givenTutor(fixture, { marketing: { whatsapp: true } })
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')

    const id = await enqueue(tutorId, 'birthday_tutor', {})
    expect((await readMessage(id)).pushTitleEncrypted).toBeNull()

    await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(pushes).toHaveLength(0)
  })

  it('a cobrança não diz o valor na tela bloqueada, e abre a conta', async () => {
    const tutorId = await givenTutor(fixture)
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')

    await enqueue(tutorId, 'dunning_soft', {
      'financeiro.valor_devido': 'R$ 180,00',
      'financeiro.dias_atraso': '10',
    })
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(whatsapp.sent[0]!.body).toContain('R$ 180,00')
    expect(pushes).toHaveLength(1)
    expect(`${pushes[0]!.title} ${pushes[0]!.body}`).not.toContain('180')
    expect(pushes[0]!.data.abre).toBe('conta')
  })

  it('sem FCM configurado, nada muda', async () => {
    installFakePush(false)
    const tutorId = await givenTutor(fixture)
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')

    const id = await enqueue(tutorId)
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(whatsapp.sent).toHaveLength(1)
    expect(pushes).toHaveLength(0)
    expect((await readMessage(id)).status).toBe('SENT')
  })
})

describe('o dono do aparelho', () => {
  it('o mesmo celular noutra conta muda de dono, noutro tenant inclusive', async () => {
    const primeiro = await givenTutor(fixture)
    const outro = await givenTenant('Outro Petshop')
    const segundo = await givenTutor(outro)

    await registerDevice({ tenantId: fixture.tenantId, tutorId: primeiro }, 'token-compartilhado-abcdefghij', 'ANDROID')
    await registerDevice({ tenantId: outro.tenantId, tutorId: segundo }, 'token-compartilhado-abcdefghij', 'ANDROID')

    const noPrimeiro = await withTenant(fixture.tenantId, (tx) => tx.pushDevice.count())
    const noSegundo = await withTenant(outro.tenantId, (tx) => tx.pushDevice.count())
    expect(noPrimeiro).toBe(0)
    expect(noSegundo).toBe(1)

    // E o aviso do primeiro petshop não chega mais àquele celular.
    await enqueue(primeiro)
    await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(pushes).toHaveLength(0)
  })

  it('a anonimização do titular apaga os aparelhos dele', async () => {
    const tutorId = await givenTutor(fixture)
    await registerDevice({ tenantId: fixture.tenantId, tutorId }, 'token-do-celular-1-abcdefghij', 'ANDROID')

    await anonymizeTutor({ tenantId: fixture.tenantId }, tutorId, {
      confirmation: 'CONFIRMO_A_ANONIMIZACAO',
      reason: 'Pedido do titular pelo Portal',
    })

    expect(await withTenant(fixture.tenantId, (tx) => tx.pushDevice.count())).toBe(0)
  })
})
