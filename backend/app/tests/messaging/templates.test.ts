import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  callAsStaff,
  callApi,
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  resetDatabase,
  resetPorts,
  type TenantFixture,
} from './fixtures.js'

/** MOD-CRM-02 — os textos, e o que a validação impede de escrever. */

let fixture: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  fixture = await givenTenant()
  installFakeEmailPort()
})

afterAll(closeHarness)

describe('catálogo', () => {
  it('entrega os textos prontos a um tenant que nunca os editou (AC-01)', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: '/v1/messaging/templates',
    })

    expect(response.statusCode).toBe(200)
    const templates = response.json().data as { key: string; isDefault: boolean }[]

    // Não há linha nenhuma no banco — os textos vêm do catálogo em código.
    const rows = await withTenant(fixture.tenantId, (tx) => tx.messageTemplate.count())
    expect(rows).toBe(0)

    expect(templates.every((template) => template.isDefault)).toBe(true)
    expect(templates.map((template) => template.key)).toContain('appointment_reminder')
  })
})

describe('edição', () => {
  it('salva o texto novo e passa a usá-lo no enfileiramento (AC-02)', async () => {
    await enableMessaging(fixture)

    const saved = await callApi({
      ...asAdmin(fixture),
      method: 'PUT',
      url: '/v1/messaging/templates/appointment_reminder/EMAIL',
      payload: {
        subject: 'Seu horário amanhã',
        body: 'Oi {{tutor.primeiro_nome}}, {{pets.lista}} tem horário às {{agendamento.hora}}.',
      },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json().isDefault).toBe(false)
    expect(saved.json().version).toBe(1)

    const tutorId = await givenTutor(fixture)
    const enqueued = await callAsStaff(fixture, {
      method: 'POST',
      url: '/v1/messages',
      payload: {
        tutorId,
        templateKey: 'appointment_reminder',
        dedupeKey: 'x1',
        variables: { 'pets.lista': 'Thor', 'agendamento.hora': '09:00' },
      },
    })

    const detail = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: `/v1/messages/${enqueued.json().id}`,
    })
    expect(detail.json().body).toBe('Oi Ana, Thor tem horário às 09:00.')
  })

  it('recusa variável que não existe naquele texto (AC-03)', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'PUT',
      url: '/v1/messaging/templates/appointment_reminder/EMAIL',
      payload: { subject: 'Oi', body: 'Olá {{pet.raca_favorita}}' },
    })

    // Variável inventada renderizaria vazio no celular do cliente: o erro precisa
    // doer na hora de escrever, não na hora de enviar.
    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_CRM_003')
    expect(response.json().errors[0].message).toContain('pet.raca_favorita')
  })

  it('exige assunto no e-mail', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'PUT',
      url: '/v1/messaging/templates/appointment_reminder/EMAIL',
      payload: { body: 'Olá {{tutor.primeiro_nome}}' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('recusa corpo acima do limite do WhatsApp (AC-05)', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'PUT',
      url: '/v1/messaging/templates/appointment_reminder/WHATSAPP',
      payload: { body: 'a'.repeat(4097) },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().errors[0].message).toContain('4096')
  })

  it('não deixa apagar um texto que nunca foi customizado (AC-04)', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'DELETE',
      url: '/v1/messaging/templates/appointment_reminder/EMAIL',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_CRM_004')
  })

  it('volta ao texto de fábrica quando o override é removido', async () => {
    await callApi({
      ...asAdmin(fixture),
      method: 'PUT',
      url: '/v1/messaging/templates/appointment_reminder/EMAIL',
      payload: { subject: 'Meu assunto', body: 'Oi {{tutor.primeiro_nome}}' },
    })

    const reset = await callApi({
      ...asAdmin(fixture),
      method: 'DELETE',
      url: '/v1/messaging/templates/appointment_reminder/EMAIL',
    })

    expect(reset.statusCode).toBe(200)
    expect(reset.json().isDefault).toBe(true)
    expect(reset.json().subject).not.toBe('Meu assunto')
  })
})

describe('prévia', () => {
  it('renderiza com dados de exemplo sem gravar nem enviar', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: '/v1/messaging/templates/preview',
      payload: {
        channel: 'EMAIL',
        templateKey: 'appointment_reminder',
        body: 'Oi {{tutor.primeiro_nome}}, {{pets.lista}} tem horário às {{agendamento.hora}}.',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().body).toBe('Oi Ana, Thor tem horário às 09:00.')

    const rows = await withTenant(fixture.tenantId, (tx) => tx.messageTemplate.count())
    expect(rows).toBe(0)
  })
})

describe('configuração', () => {
  it('recusa janela invertida', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/messaging/settings',
      payload: { quietStart: '20:00', quietEnd: '08:00' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('devolve os padrões antes de qualquer edição', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: '/v1/messaging/settings',
    })

    const settings = response.json()
    // Nasce desligado: ligar o motor é decisão de quem responde pelo domínio.
    expect(settings.enabled).toBe(false)
    expect(settings.quietStart).toBe('08:00')
    expect(settings.quietEnd).toBe('20:00')
    expect(settings.timezone).toBe('America/Sao_Paulo')
  })
})
