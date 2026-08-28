import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  asReceptionist,
  asService,
  callApi,
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  installFakeWhatsAppPort,
  resetDatabase,
  resetPorts,
  type TenantFixture,
} from './harness.js'

/** MOD-CRM-03 e MOD-CRM-04 — o enfileiramento e o que ele recusa. */

let fixture: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  fixture = await givenTenant()
  installFakeEmailPort()
})

afterAll(closeHarness)

function enqueue(tutorId: string, overrides: Record<string, unknown> = {}) {
  return callApi({
    ...asService(fixture),
    method: 'POST',
    url: '/v1/messages',
    payload: {
      tutorId,
      templateKey: 'appointment_reminder',
      dedupeKey: `reminder:${tutorId}`,
      variables: { 'pets.lista': 'Thor', 'agendamento.data': 'quinta', 'agendamento.hora': '09:00' },
      ...overrides,
    },
  })
}

describe('enfileiramento', () => {
  it('aceita a mensagem e renderiza o corpo com as variáveis (AC-01)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const response = await enqueue(tutorId)

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.duplicate).toBe(false)

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: body.id } }),
    )
    expect(message.channel).toBe('EMAIL')
    expect(message.category).toBe('TRANSACTIONAL')

    const detail = await callApi({ ...asAdmin(fixture), method: 'GET', url: `/v1/messages/${body.id}` })
    // O nome do tutor e o do petshop entram sem o chamador pedir.
    expect(detail.json().body).toContain('Ana')
    expect(detail.json().body).toContain('Thor')
    expect(detail.json().body).toContain('Petshop Teste')
  })

  it('recusa quando o motor está desligado, em vez de acumular fila (RN-13)', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await enqueue(tutorId)

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_CRM_013')
  })

  it('devolve a mensagem existente quando o dedupeKey repete (AC-04)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const first = await enqueue(tutorId)
    const second = await enqueue(tutorId)

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(200)
    expect(second.json().duplicate).toBe(true)
    expect(second.json().id).toBe(first.json().id)

    const count = await withTenant(fixture.tenantId, (tx) => tx.message.count())
    expect(count).toBe(1)
  })

  it('recusa um texto que não existe', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const response = await enqueue(tutorId, { templateKey: 'nao_existe' })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_CRM_002')
  })
})

describe('escolha de canal (AC-02)', () => {
  it('cai para e-mail quando o WhatsApp não está conectado', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const response = await enqueue(tutorId)

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: response.json().id } }),
    )
    // O tutor tem telefone; o canal só não foi escolhido porque a porta está fora.
    expect(message.channel).toBe('EMAIL')
  })

  it('prefere WhatsApp quando o canal está de pé', async () => {
    installFakeWhatsAppPort()
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const response = await enqueue(tutorId)

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: response.json().id } }),
    )
    expect(message.channel).toBe('WHATSAPP')
  })

  it('bloqueia sem erro quando o tutor não tem nenhum contato utilizável', async () => {
    await enableMessaging(fixture)
    // Sem e-mail, e o WhatsApp está fora do ar nesta fatia.
    const tutorId = await givenTutor(fixture, { email: null })

    const response = await enqueue(tutorId)

    expect(response.statusCode).toBe(202)
    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: response.json().id } }),
    )
    expect(message.status).toBe('BLOCKED')
    expect(message.blockReason).toBe('NO_CHANNEL')
  })
})

describe('consentimento por categoria (MOD-CRM-04)', () => {
  it('deixa o lembrete passar mesmo com o marketing revogado (AC-01)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { marketing: { email: false } })

    const response = await enqueue(tutorId)

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: response.json().id } }),
    )
    // Lembrete de compromisso é execução de contrato, não propaganda.
    expect(message.status).toBe('QUEUED')
    expect(message.blockReason).toBeNull()
  })
})

describe('supressão (AC-05 de MOD-CRM-04)', () => {
  it('bloqueia o endereço suprimido em qualquer categoria', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { email: 'ana@exemplo.com' })

    await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: '/v1/messaging/suppressions',
      payload: { channel: 'EMAIL', address: 'ana@exemplo.com', reason: 'HARD_BOUNCE' },
    })

    const response = await enqueue(tutorId)

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: response.json().id } }),
    )
    expect(message.status).toBe('BLOCKED')
    expect(message.blockReason).toBe('SUPPRESSED')
  })
})

describe('permissões (§9)', () => {
  it('deixa a recepção ler o histórico', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    await enqueue(tutorId)

    const response = await callApi({ ...asReceptionist(fixture), method: 'GET', url: '/v1/messages' })

    expect(response.statusCode).toBe(200)
    expect(response.json().total).toBe(1)
  })

  it('impede a recepção de editar o texto', async () => {
    const response = await callApi({
      ...asReceptionist(fixture),
      method: 'PUT',
      url: '/v1/messaging/templates/appointment_reminder/EMAIL',
      payload: { subject: 'Oi', body: 'Olá {{tutor.primeiro_nome}}' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_CRM_012')
  })
})
