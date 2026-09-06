import { PdfUnavailableError } from '@petshop/pdf'
import { AppError } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  callApi,
  captureMessages,
  closeHarness,
  fakePdf,
  fakeTutorService,
  givenTutor,
  givenTenant,
  resetDatabase,
  type PdfDouble,
  type SentContactCode,
  type TenantFixture,
  type TutorServiceDouble,
} from './harness.js'

/**
 * MOD-PORTAL-09 — Meus Dados.
 *
 * O que esta suíte guarda são as três coisas que o módulo acrescenta, e nenhuma delas
 * tem dono em outro serviço:
 *
 * 1. **o recorte de leitura** — o que a ficha do balcão tem e a do titular não;
 * 2. **os campos travados**, que aqui são mais que no MOD-PORTAL-03: além de preço, a
 *    identidade. Um `.strict()` que deixasse `fullName` passar não quebraria teste nenhum
 *    das outras suítes;
 * 3. **a prova de posse do contato novo** (AC-02), que é a razão de o módulo existir — e
 *    cuja falha silenciosa mais perigosa é o código sair para o endereço **antigo**.
 *
 * A cifragem, a trilha e a validação de endereço têm suíte no `tutor-service`. Aqui o
 * dublê da porta grava de verdade no banco (ver `fakeTutorService`), porque o que os
 * testes afirmam é o estado depois de salvar, não a resposta da porta.
 */

let fixture: TenantFixture
let tutorService: TutorServiceDouble
let contactCodes: SentContactCode[]
let pdf: PdfDouble

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  tutorService = fakeTutorService(fixture)
  contactCodes = captureMessages().contactCodes
  pdf = fakePdf()
})

afterAll(async () => {
  await closeHarness()
})

describe('GET /portal/v1/me/data', () => {
  it('AC-01: devolve a ficha do titular com o documento e o telefone mascarados', async () => {
    const tutorId = await givenTutor(fixture, {
      name: 'Maria Souza',
      phone: '+5511987654321',
      email: 'maria@exemplo.com',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/me/data',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.profile.fullName).toBe('Maria Souza')
    expect(body.profile.phoneMasked).toBe('(11) *****-4321')
    // O e-mail sai por extenso: é o que o titular precisa ler para saber se está certo.
    expect(body.profile.email).toBe('maria@exemplo.com')
    expect(body.pendingContact).toBeNull()
    expect(body.deletionRequest).toBeNull()
  })

  it('não devolve as anotações internas da recepção', async () => {
    const tutorId = await givenTutor(fixture)
    await callApi({ method: 'GET', url: '/portal/v1/me/data', ...asTutor(fixture, tutorId) })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/me/data',
      ...asTutor(fixture, tutorId),
    })

    // `notes` é caderno de trabalho da equipe. A ausência é a garantia, e some sem
    // barulho: nenhuma outra asserção desta suíte quebraria se o campo voltasse.
    expect(response.json().profile).not.toHaveProperty('notes')
  })
})

describe('PATCH /portal/v1/me/data', () => {
  it('AC-01: o titular muda o nome social e a data de nascimento', async () => {
    const tutorId = await givenTutor(fixture, { name: 'Maria Souza' })

    const response = await callApi({
      method: 'PATCH',
      url: '/portal/v1/me/data',
      payload: { socialName: 'Mari', birthDate: '1990-04-12' },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.profile.socialName).toBe('Mari')
    // RN-14: o nome social é o nome exibido a partir daqui.
    expect(body.profile.displayName).toBe('Mari')
    expect(body.profile.birthDate).toBe('1990-04-12')
    expect(tutorService.writes).toEqual([{ kind: 'profile', tutorId }])
  })

  it('AC-03: recusa o CPF com 422 e não chega a chamar a porta', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'PATCH',
      url: '/portal/v1/me/data',
      payload: { cpf: '39053344705' },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PORTAL_007')
    // A trava é o contrato: a requisição morre antes do handler, e o tutor-service nunca
    // recebe um corpo com CPF dentro.
    expect(tutorService.writes).toHaveLength(0)
  })

  it('recusa o nome civil e o telefone pelo mesmo caminho do CPF', async () => {
    const tutorId = await givenTutor(fixture)

    for (const payload of [{ fullName: 'Outra Pessoa' }, { phone: '11999998888' }]) {
      const response = await callApi({
        method: 'PATCH',
        url: '/portal/v1/me/data',
        payload,
        ...asTutor(fixture, tutorId),
      })
      expect(response.statusCode).toBe(422)
    }

    expect(tutorService.writes).toHaveLength(0)
  })
})

describe('POST /portal/v1/me/contact', () => {
  it('AC-02: o código sai para o contato NOVO, e a ficha não muda antes dele', async () => {
    const tutorId = await givenTutor(fixture, { phone: '+5511987654321' })

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact',
      payload: { field: 'PHONE', value: '11955554444' },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json().maskedTarget).toBe('(11) *****-4444')

    /**
     * A asserção que mais importa do módulo inteiro.
     *
     * Um código enviado ao telefone antigo provaria a posse do contato que está sendo
     * trocado — nada. E passaria por toda a suíte sem falhar mais nada.
     */
    expect(contactCodes).toHaveLength(1)
    expect(contactCodes[0]?.address).toBe('+5511955554444')
    expect(contactCodes[0]?.channel).toBe('WHATSAPP')

    // Nada foi gravado na ficha ainda.
    expect(tutorService.writes).toHaveLength(0)
    const dados = await callApi({
      method: 'GET',
      url: '/portal/v1/me/data',
      ...asTutor(fixture, tutorId),
    })
    expect(dados.json().profile.phoneMasked).toBe('(11) *****-4321')
    expect(dados.json().pendingContact.field).toBe('PHONE')
  })

  it('AC-02: 409 quando o contato novo já é de outra ficha, sem dizer de quem', async () => {
    const tutorId = await givenTutor(fixture, { phone: '+5511987654321' })
    await givenTutor(fixture, { name: 'João Vizinho', phone: '+5511955554444' })

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact',
      payload: { field: 'PHONE', value: '11955554444' },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_PORTAL_012')
    // Nem o nome, nem o id, nem a confirmação de que a outra ficha existe.
    expect(JSON.stringify(response.json())).not.toContain('João')
    expect(contactCodes).toHaveLength(0)
  })

  it('recusa o contato que já é o atual, em vez de mandar um código à toa', async () => {
    const tutorId = await givenTutor(fixture, { phone: '+5511987654321' })

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact',
      payload: { field: 'PHONE', value: '11987654321' },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(422)
    expect(contactCodes).toHaveLength(0)
  })

  it('o pedido novo mata o anterior: só o último código vale', async () => {
    const tutorId = await givenTutor(fixture)

    const primeiro = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact',
      payload: { field: 'EMAIL', value: 'errado@exemplo.com' },
      ...asTutor(fixture, tutorId),
    })
    const segundo = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact',
      payload: { field: 'EMAIL', value: 'certo@exemplo.com' },
      ...asTutor(fixture, tutorId),
    })

    /**
     * O código do primeiro pedido não vale mais.
     *
     * Sem consumir o anterior, o tutor que corrigisse um dígito errado teria dois códigos
     * vivos — e o que entraria na ficha seria o do endereço que ele acabou de descartar.
     */
    const comAntigo = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId: primeiro.json().changeId, code: contactCodes[0]?.code },
      ...asTutor(fixture, tutorId),
    })
    expect(comAntigo.statusCode).toBe(422)

    const comNovo = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId: segundo.json().changeId, code: contactCodes[1]?.code },
      ...asTutor(fixture, tutorId),
    })
    expect(comNovo.statusCode).toBe(200)
    expect(comNovo.json().profile.email).toBe('certo@exemplo.com')
  })
})

describe('POST /portal/v1/me/contact/verify', () => {
  async function pedirCodigo(
    tutorId: string,
    field: 'PHONE' | 'EMAIL',
    value: string,
  ): Promise<string> {
    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact',
      payload: { field, value },
      ...asTutor(fixture, tutorId),
    })
    return response.json().changeId as string
  }

  it('AC-02: o código certo grava o contato e devolve a ficha atualizada', async () => {
    const tutorId = await givenTutor(fixture, { phone: '+5511987654321' })
    const changeId = await pedirCodigo(tutorId, 'PHONE', '11955554444')

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId, code: contactCodes[0]?.code },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().profile.phoneMasked).toBe('(11) *****-4444')
    expect(response.json().pendingContact).toBeNull()
    expect(tutorService.writes).toEqual([{ kind: 'contact', tutorId }])
  })

  it('o mesmo código não vale duas vezes', async () => {
    const tutorId = await givenTutor(fixture)
    const changeId = await pedirCodigo(tutorId, 'EMAIL', 'nova@exemplo.com')
    const code = contactCodes[0]?.code

    await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId, code },
      ...asTutor(fixture, tutorId),
    })
    const segunda = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId, code },
      ...asTutor(fixture, tutorId),
    })

    expect(segunda.statusCode).toBe(422)
    expect(segunda.json().code).toBe('ERR_PORTAL_002')
  })

  it('cinco erros matam o pedido, e a contagem sobrevive ao erro que a rota lança', async () => {
    const tutorId = await givenTutor(fixture)
    const changeId = await pedirCodigo(tutorId, 'EMAIL', 'nova@exemplo.com')

    for (let i = 0; i < 4; i += 1) {
      const errada = await callApi({
        method: 'POST',
        url: '/portal/v1/me/contact/verify',
        payload: { changeId, code: '000000' },
        ...asTutor(fixture, tutorId),
      })
      expect(errada.statusCode).toBe(422)
    }

    /**
     * A quinta é o teto. Se a contagem rodasse dentro da transação que lança, o `throw`
     * a desfaria a cada tentativa e este 429 nunca chegaria — força bruta funcionando
     * com o código do teto no lugar, aparentemente correto.
     */
    const quinta = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId, code: '000000' },
      ...asTutor(fixture, tutorId),
    })
    expect(quinta.statusCode).toBe(429)

    // E o código certo já não vale mais: o pedido morreu junto.
    const comCerto = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId, code: contactCodes[0]?.code },
      ...asTutor(fixture, tutorId),
    })
    expect(comCerto.statusCode).toBe(422)
    expect(tutorService.writes).toHaveLength(0)
  })

  it('RN-03: o pedido de outro tutor responde como código inválido', async () => {
    const dono = await givenTutor(fixture, { phone: '+5511911112222' })
    const intruso = await givenTutor(fixture, { name: 'Outro', phone: '+5511933334444' })
    const changeId = await pedirCodigo(dono, 'EMAIL', 'nova@exemplo.com')

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/contact/verify',
      payload: { changeId, code: contactCodes[0]?.code },
      ...asTutor(fixture, intruso),
    })

    expect(response.statusCode).toBe(422)
    expect(tutorService.writes).toHaveLength(0)
  })
})

describe('endereços', () => {
  const endereco = {
    label: 'Casa',
    zipCode: '01310100',
    street: 'Avenida Paulista',
    number: '1000',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'SP',
    isPrimary: true,
  }

  it('AC-01: o titular cadastra o próprio endereço', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/addresses',
      payload: endereco,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(201)
    const enderecos = response.json().addresses
    expect(enderecos).toHaveLength(1)
    expect(enderecos[0].street).toBe('Avenida Paulista')
    expect(enderecos[0].isPrimary).toBe(true)
  })

  it('não aceita coordenadas do cliente', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/addresses',
      payload: { ...endereco, latitude: -23.5, longitude: -46.6 },
      ...asTutor(fixture, tutorId),
    })

    // Quem geocodifica é o MOD-TAXI. Aceitar aqui deixaria o tutor mover o ponto de
    // coleta da van sem mudar uma letra do endereço.
    expect(response.statusCode).toBe(422)
  })

  it('AC-03 de MOD-PORTAL-02: endereço de outra ficha responde 404, não 403', async () => {
    const dono = await givenTutor(fixture, { phone: '+5511911112222' })
    const intruso = await givenTutor(fixture, { name: 'Outro', phone: '+5511933334444' })

    const criado = await callApi({
      method: 'POST',
      url: '/portal/v1/me/addresses',
      payload: endereco,
      ...asTutor(fixture, dono),
    })
    const addressId = criado.json().addresses[0].id as string

    const response = await callApi({
      method: 'PATCH',
      url: `/portal/v1/me/addresses/${addressId}`,
      payload: { number: '2000' },
      ...asTutor(fixture, intruso),
    })

    // 403 confirmaria que o endereço existe. A porta assina `tutor:update` para o tenant
    // inteiro — quem recorta por tutor é o BFF, e é isso que este teste guarda.
    expect(response.statusCode).toBe(404)
  })
})

describe('POST /portal/v1/me/deletion-request', () => {
  it('AC-05: registra o pedido, informa o prazo e não apaga nada', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/deletion-request',
      payload: { reason: 'Não quero mais receber nada' },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(201)
    const pedido = response.json().deletionRequest
    expect(pedido.status).toBe('OPEN')
    expect(new Date(pedido.dueAt).getTime()).toBeGreaterThan(Date.now())

    // A ficha continua inteira: o pedido é encaminhamento, não execução.
    expect(response.json().profile.fullName).toBe('Maria Souza')
  })

  it('AC-05: o segundo pedido em aberto é recusado', async () => {
    const tutorId = await givenTutor(fixture)

    await callApi({
      method: 'POST',
      url: '/portal/v1/me/deletion-request',
      payload: {},
      ...asTutor(fixture, tutorId),
    })
    const segunda = await callApi({
      method: 'POST',
      url: '/portal/v1/me/deletion-request',
      payload: {},
      ...asTutor(fixture, tutorId),
    })

    // Três cliques ansiosos virariam três pendências para a mesma decisão.
    expect(segunda.statusCode).toBe(409)
    expect(segunda.json().code).toBe('ERR_TUTOR_010')
  })

  it('a falha do tutor-service vira erro do Portal, e não 500', async () => {
    const tutorId = await givenTutor(fixture)
    tutorService.failWith = new AppError('ERR_TUTOR_001', 'Tutor não encontrado')

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/me/deletion-request',
      payload: {},
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('GET /portal/v1/me/export', () => {
  it('AC-04: o titular baixa os próprios dados, pelo caminho que audita a leitura', async () => {
    const tutorId = await givenTutor(fixture, { name: 'Maria Souza' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/me/export',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().tutor.fullName).toBe('Maria Souza')

    /**
     * Delegado ao tutor-service, e não refeito aqui.
     *
     * É lá que a leitura vira `tutor.exported` na trilha — a prova de que o direito de
     * acesso foi exercido e quando. Uma consulta ao banco daqui produziria o mesmo JSON
     * sem prova nenhuma, e o teste passaria igual.
     */
    expect(tutorService.writes).toEqual([{ kind: 'export', tutorId }])
  })
})


/**
 * A mesma exportação, em papel.
 *
 * O que estes testes guardam não é o PDF — é **a folha**: que ela sai pelo caminho que
 * audita a leitura, que o que estava no JSON continua lá dentro, e que campo livre de
 * cadastro não vira execução dentro do Chromium do Gotenberg.
 */
describe('GET /portal/v1/me/export/pdf', () => {
  it('AC-04: devolve o documento pelo mesmo caminho que audita a leitura', async () => {
    const tutorId = await givenTutor(fixture, { name: 'Maria Souza' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/me/export/pdf',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/pdf')
    expect(response.headers['content-disposition']).toMatch(
      /attachment; filename="meus-dados-\d{4}-\d{2}-\d{2}\.pdf"/,
    )
    // Dado pessoal não fica no cache de ninguém.
    expect(response.headers['cache-control']).toBe('no-store')

    // Delegado ao tutor-service, como o JSON: é lá que a leitura vira `tutor.exported`.
    expect(tutorService.writes).toEqual([{ kind: 'export', tutorId }])
  })

  it('a folha leva o que o titular tem direito de ler, anotação da recepção inclusive', async () => {
    const tutorId = await givenTutor(fixture, {
      name: 'Maria Souza',
      notes: 'Prefere a Ana. Sempre atrasa 10 minutos.',
    })

    await callApi({
      method: 'GET',
      url: '/portal/v1/me/export/pdf',
      ...asTutor(fixture, tutorId),
    })

    const folha = pdf.htmls[0] ?? ''
    expect(folha).toContain('Maria Souza')
    expect(folha).toContain('Prefere a Ana')
    // O nome do petshop responde pelo tratamento: uma folha de dados pessoais sem
    // controlador identificado não serve a quem a recebe.
    expect(folha).toContain('Petshop do João')
  })

  it('campo livre do cadastro não vira execução dentro do Gotenberg', async () => {
    const tutorId = await givenTutor(fixture, {
      name: 'Maria Souza',
      notes: '<script>alert(1)</script>',
    })

    await callApi({
      method: 'GET',
      url: '/portal/v1/me/export/pdf',
      ...asTutor(fixture, tutorId),
    })

    const folha = pdf.htmls[0] ?? ''
    expect(folha).not.toContain('<script>alert(1)</script>')
    expect(folha).toContain('&lt;script&gt;')
  })

  it('Gotenberg fora do ar vira 502, e não 500', async () => {
    const tutorId = await givenTutor(fixture)
    pdf.failWith = new PdfUnavailableError('Gotenberg respondeu 503')

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/me/export/pdf',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(502)
    // A exportação chegou a ser lida: o que faltou foi o papel.
    expect(tutorService.writes).toEqual([{ kind: 'export', tutorId }])
  })
})
