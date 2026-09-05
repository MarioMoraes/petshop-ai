import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashSearchable, withTenant } from '@petshop/db'
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

/** O corpo decifrado, pela mesma rota que a tela usa. */
async function readBody(id: string): Promise<string> {
  const response = await callApi({ ...asAdmin(fixture), method: 'GET', url: `/v1/messages/${id}` })
  expect(response.statusCode).toBe(200)
  return response.json().body as string
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

describe('variáveis que o motor resolve sozinho', () => {
  it('preenche {{petshop.telefone}} com o contato público do estabelecimento', async () => {
    await enableMessaging(fixture)
    // O campo entrou em `tenant_settings` com o perfil público do tenant. Antes dele
    // toda mensagem saía dizendo "avise pelo " e parava ali.
    await withTenant(fixture.tenantId, (tx) =>
      tx.tenantSettings.update({
        where: { tenantId: fixture.tenantId },
        data: { publicWhatsapp: '(11) 4002-8922' },
      }),
    )
    const tutorId = await givenTutor(fixture)

    const id = (await enqueue(tutorId)).json().id
    const body = await readBody(id)

    expect(body).toContain('(11) 4002-8922')
    expect(body).not.toContain('{{petshop.telefone}}')
  })

  it('cai no telefone fixo quando não há WhatsApp público', async () => {
    await enableMessaging(fixture)
    await withTenant(fixture.tenantId, (tx) =>
      tx.tenantSettings.update({
        where: { tenantId: fixture.tenantId },
        data: { publicPhone: '(11) 3333-4444' },
      }),
    )
    const tutorId = await givenTutor(fixture)

    const body = await readBody((await enqueue(tutorId)).json().id)

    expect(body).toContain('(11) 3333-4444')
  })
})

describe('o que a leitura devolve (MOD-CRM-10 e MOD-CRM-11)', () => {
  it('traz o nome do destinatário junto da linha', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    await enqueue(tutorId)

    const response = await callApi({ ...asAdmin(fixture), method: 'GET', url: '/v1/messages' })

    expect(response.statusCode).toBe(200)
    // Sem isto o painel listaria vinte UUIDs — e a tela teria de buscar cada nome
    // por HTTP, uma ida ao gateway por linha.
    expect(response.json().data[0].tutorName).toBe('Ana Souza')
  })

  it('traz o nome também na leitura de uma mensagem só', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    const id = (await enqueue(tutorId)).json().id

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: `/v1/messages/${id}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().tutorName).toBe('Ana Souza')
  })

  it('lista o histórico pela rota da ficha do tutor', async () => {
    await enableMessaging(fixture)
    const [tutorId, outroId] = [await givenTutor(fixture), await givenTutor(fixture)]
    await enqueue(tutorId)
    await enqueue(outroId)

    const response = await callApi({
      ...asReceptionist(fixture),
      method: 'GET',
      url: `/v1/tutors/${tutorId}/messages`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().total).toBe(1)
    expect(response.json().data[0].tutorId).toBe(tutorId)
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

/**
 * O destino imposto (`overrideAddress`) — MOD-PORTAL-09, AC-02.
 *
 * O campo existe por um caso só: provar que o tutor possui o telefone ou o e-mail
 * **novo**, que ainda não está na ficha. O risco que ele cria é evidente — um caminho
 * para mandar mensagem a qualquer endereço digitado —, e o que o contém são as guardas
 * exercitadas aqui.
 */
describe('destino imposto pelo chamador', () => {
  it('manda para o endereço pedido, e não para o da ficha', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { email: 'antigo@exemplo.com' })

    const response = await enqueue(tutorId, {
      templateKey: 'portal_codigo_contato',
      channel: 'EMAIL',
      overrideAddress: 'novo@exemplo.com',
      variables: { 'portal.codigo': '123456' },
      urgent: true,
      dedupeKey: `contato:${tutorId}`,
    })

    expect(response.statusCode).toBe(202)
    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: response.json().id } }),
    )

    /**
     * A asserção que justifica o campo inteiro.
     *
     * Se a cascata comum tivesse resolvido o destino, o código sairia para o contato
     * antigo — provando a posse justamente do endereço que está sendo trocado, e
     * aprovando a troca com prova nenhuma.
     */
    expect(message.status).not.toBe('BLOCKED')
    expect(message.toHash).toBe(hashSearchable('messaging:email', 'novo@exemplo.com'))
  })

  it('recusa o destino imposto sem canal explícito', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const response = await enqueue(tutorId, {
      templateKey: 'portal_codigo_contato',
      overrideAddress: 'novo@exemplo.com',
      variables: { 'portal.codigo': '123456' },
      dedupeKey: `contato:${tutorId}`,
    })

    // Sem canal, `AUTO` escolheria pela ficha — e cairia no contato antigo.
    expect(response.statusCode).toBe(422)
  })

  it('respeita a supressão: quem pediu para não receber continua sem receber', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: '/v1/messaging/suppressions',
      payload: { channel: 'EMAIL', address: 'novo@exemplo.com', reason: 'HARD_BOUNCE' },
    })

    const response = await enqueue(tutorId, {
      templateKey: 'portal_codigo_contato',
      channel: 'EMAIL',
      overrideAddress: 'novo@exemplo.com',
      variables: { 'portal.codigo': '123456' },
      urgent: true,
      dedupeKey: `contato:${tutorId}`,
    })

    // A supressão é do endereço, não da ficha: ninguém volta a receber por alguém ter
    // digitado o endereço dele numa tela nossa.
    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: response.json().id } }),
    )
    expect(message.status).toBe('BLOCKED')
    expect(message.blockReason).toBe('SUPPRESSED')
  })
})
