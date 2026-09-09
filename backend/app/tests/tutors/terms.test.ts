import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PdfUnavailableError, setPdfPort } from '../../src/modules/terms/pdf-port.js'
import { setStoragePort } from '../../src/shared/document-storage.js'
import { retryPendingTermDocuments } from '../../src/modules/terms/acceptance.js'
import {
  asAdmin,
  asRole,
  callApi,
  closeHarness,
  givenIssuerSettings,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-DOC fatia 3 — termos versionados (06), termo de responsabilidade (07) e
 * autorização de uso de imagem (08).
 *
 * O Gotenberg e o R2 são dublados, como no receituário: o que está sob teste é a
 * imutabilidade da versão publicada, a validação do que o aceite cita e a prova que
 * fica gravada — não o protocolo HTTP do Chromium, que `packages/pdf` já cobre.
 *
 * O que **não** é dublado é o miolo do documento: o HTML que sobe para o dublê é o
 * mesmo que iria para o Chromium, e é nele que se confere o escape do texto do tenant.
 */

let tenant: TenantFixture
let tutorId: string

interface FakePdf {
  calls: string[]
  failWith: Error | null
}

let pdf: FakePdf
let objetos: Map<string, Buffer>

function installFakes(): void {
  pdf = { calls: [], failWith: null }
  objetos = new Map()

  setPdfPort({
    async render(html) {
      if (pdf.failWith) throw pdf.failWith
      pdf.calls.push(html)
      return Buffer.from('%PDF-1.4 dublê')
    },
  })

  setStoragePort({
    async put(key, body) {
      objetos.set(key, body)
    },
    async signedUrl(key) {
      return `https://r2.test/${key}?assinada=1`
    },
    // O leitor entrou na porta com o anexo de e-mail do MOD-NOTIF-05. Nenhum teste
    // deste serviço o exercita — quem lê é o messaging-service —, mas a interface é
    // uma só, e um dublê que só sabe escrever esconderia a metade que falta.
    async read(key) {
      const stored = objetos.get(key)
      if (!stored) throw new Error(`objeto inexistente: ${key}`)
      return stored
    },
  })
}

beforeEach(async () => {
  await resetDatabase()
  installFakes()
  tenant = await givenTenant()
  await givenIssuerSettings(tenant)

  const created = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/tutors',
    payload: {
      fullName: 'Maria Silva',
      cpf: '39053344705',
      phone: '11987654321',
      consents: { whatsapp: true, email: true, terms: true },
    },
  })
  tutorId = created.json().id
})

afterAll(async () => {
  setPdfPort(null)
  setStoragePort(null)
  await closeHarness()
})

function publicar(payload: Record<string, unknown>) {
  return callApi({ ...asAdmin(tenant), method: 'POST', url: '/v1/terms', payload })
}

function aceitar(payload: Record<string, unknown>) {
  return callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: `/v1/tutors/${tutorId}/term-acceptances`,
    payload,
  })
}

const CORPO =
  '## Objeto\n\nO tutor declara ciência dos riscos do procedimento e autoriza a contenção ' +
  'física necessária à segurança do animal e da equipe.'

describe('MOD-DOC-06 — termos versionados', () => {
  it('AC-02: o tenant nasce com as três versões 1.0 da plataforma', async () => {
    const response = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/terms' })

    expect(response.statusCode).toBe(200)
    const { versions } = response.json()
    expect(versions).toHaveLength(3)
    for (const version of versions) {
      expect(version.version).toBe('1.0')
      expect(version.current).toBe(true)
      expect(version.body.length).toBeGreaterThan(200)
    }

    // O parque existente cita a 1.0 em toda linha; é ela que o seed torna válida.
    const aceites = await ownerPrisma.tutorConsent.findMany({ where: { tutorId } })
    expect(aceites.every((row) => row.version === '1.0')).toBe(true)
  })

  it('AC-01: publicar uma versão nova mantém a anterior legível', async () => {
    const response = await publicar({
      kind: 'SERVICE_LIABILITY',
      version: '2.0',
      title: 'Termo de responsabilidade',
      body: CORPO,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().current).toBe(true)

    const { versions } = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/terms' })
    ).json()
    const liability = versions.filter(
      (item: { kind: string }) => item.kind === 'SERVICE_LIABILITY',
    )
    expect(liability).toHaveLength(2)
    expect(liability.find((item: { version: string }) => item.version === '1.0').current).toBe(
      false,
    )
  })

  it('AC-04: republicar o mesmo número é 409 — versão publicada é imutável', async () => {
    const response = await publicar({
      kind: 'SERVICE_LIABILITY',
      version: '1.0',
      title: 'Outro texto',
      body: CORPO,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_DOC_004')
  })

  it('AC-03: aceite que cita versão inexistente é 422', async () => {
    const response = await aceitar({ kind: 'SERVICE_LIABILITY', version: '9.9' })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_DOC_007')
    expect(await ownerPrisma.tutorConsent.count({ where: { channel: 'SERVICE_LIABILITY' } })).toBe(
      0,
    )
  })

  it('publicar exige tenant:configure — ler o termo não', async () => {
    // A recepção tem `tenant:read_settings` e não tem `tenant:configure` — o recorte
    // exato deste AC, agora vindo da matriz.
    const recepcao = await asRole(tenant, 'RECEPTIONIST')

    const semPermissao = await callApi({
      ...recepcao,
      method: 'POST',
      url: '/v1/terms',
      payload: { kind: 'TERMS', version: '3.0', title: 'Termos', body: CORPO },
    })

    expect(semPermissao.statusCode).toBe(403)

    const leitura = await callApi({
      ...recepcao,
      method: 'GET',
      url: '/v1/terms/current/SERVICE_LIABILITY',
    })
    expect(leitura.statusCode).toBe(200)
    expect(leitura.json().version).toBe('1.0')
  })
})

describe('MOD-DOC-07 — termo de responsabilidade', () => {
  it('AC-01: o aceite grava a prova e arquiva o papel', async () => {
    const response = await aceitar({ kind: 'SERVICE_LIABILITY' })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.version).toBe('1.0')
    expect(body.documentNumber).toMatch(/^TR-\d{4}\/\d{6}$/)
    expect(body.documentStatus).toBe('ISSUED')

    const consent = await ownerPrisma.tutorConsent.findFirstOrThrow({
      where: { tutorId, channel: 'SERVICE_LIABILITY' },
    })
    expect(consent.granted).toBe(true)
    expect(consent.source).toBe('STAFF_FORM')
    expect(consent.userAgent).not.toBeNull()
    expect(consent.documentId).toBe(body.documentId)

    const document = await ownerPrisma.document.findFirstOrThrow({
      where: { id: body.documentId },
    })
    expect(document.kind).toBe('TERM_ACCEPTANCE')
    expect(document.status).toBe('ISSUED')
    expect(document.tutorId).toBe(tutorId)
    // Guarda de cinco anos (RN-17), contada da emissão.
    expect(document.retentionUntil).not.toBeNull()
    expect(objetos.size).toBe(1)
  })

  it('o papel traz o texto aceito, o CPF mascarado e a prova de origem', async () => {
    await aceitar({ kind: 'SERVICE_LIABILITY' })

    const html = pdf.calls[0] ?? ''
    expect(html).toContain('ciência de riscos')
    expect(html).toContain('***.***.447-05')
    expect(html).toContain('Registro do aceite')
    expect(html).toContain('Balcão do estabelecimento')
    // O CPF inteiro não escapa nem para o papel.
    expect(html).not.toContain('39053344705')
  })

  it('escapa o texto que o tenant digitou — o Gotenberg roda um Chromium', async () => {
    await publicar({
      kind: 'SERVICE_LIABILITY',
      version: '2.0',
      title: 'Termo de responsabilidade',
      body: '## Porte\n\nFilhotes <script>alert(1)</script> com menos de 3 kg exigem contenção especial.',
    })

    await aceitar({ kind: 'SERVICE_LIABILITY' })

    const html = pdf.calls[0] ?? ''
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('AC-03: aceitar de novo a mesma versão é 409 e não grava nada', async () => {
    await aceitar({ kind: 'SERVICE_LIABILITY' })
    const repetido = await aceitar({ kind: 'SERVICE_LIABILITY' })

    expect(repetido.statusCode).toBe(409)
    expect(repetido.json().code).toBe('ERR_DOC_006')
    expect(
      await ownerPrisma.tutorConsent.count({ where: { tutorId, channel: 'SERVICE_LIABILITY' } }),
    ).toBe(1)
  })

  it('AC-04: termo novo põe o aceite anterior em PENDING_RENEWAL', async () => {
    await aceitar({ kind: 'SERVICE_LIABILITY' })

    await publicar({
      kind: 'SERVICE_LIABILITY',
      version: '2.0',
      title: 'Termo de responsabilidade',
      body: CORPO,
    })

    const consents = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}/consents` })
    ).json()

    const estado = consents.current.find(
      (item: { channel: string }) => item.channel === 'SERVICE_LIABILITY',
    )
    expect(estado.state).toBe('PENDING_RENEWAL')
    expect(estado.granted).toBe(true)

    // O termo de uso não foi republicado: quem aceitou a 1.0 dele segue vigente.
    const termos = consents.current.find((item: { channel: string }) => item.channel === 'TERMS')
    expect(termos.state).toBe('GRANTED')
  })

  it('AC-05: revogar não apaga o papel — ele prova o que valia enquanto valia', async () => {
    const aceite = await aceitar({ kind: 'SERVICE_LIABILITY' })
    const documentId = aceite.json().documentId

    await callApi({
      ...asAdmin(tenant),
      method: 'PUT',
      url: `/v1/tutors/${tutorId}/consents`,
      payload: { transitions: [{ channel: 'SERVICE_LIABILITY', granted: false }] },
    })

    const document = await ownerPrisma.document.findFirstOrThrow({ where: { id: documentId } })
    expect(document.status).toBe('ISSUED')

    const consents = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}/consents` })
    ).json()
    expect(
      consents.current.find((item: { channel: string }) => item.channel === 'SERVICE_LIABILITY')
        .state,
    ).toBe('REVOKED')
    expect(consents.history).toHaveLength(6)
  })

  it('AC-02 de MOD-DOC-01: tenant sem endereço não emite, e a resposta diz o que falta', async () => {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      // O CHECK `tenant_settings_address_complete` é tudo ou nada: limpar meio endereço
      // seria recusado pelo banco antes de chegar ao caso sob teste.
      data: {
        addressStreet: null,
        addressZip: null,
        addressNumber: null,
        addressDistrict: null,
        addressCity: null,
        addressState: null,
      },
    })

    const response = await aceitar({ kind: 'SERVICE_LIABILITY' })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_DOC_002')
    expect(response.json().detail).toContain('endereço')
    // Nada foi gravado: a prova e o papel nascem juntos ou não nascem.
    expect(
      await ownerPrisma.tutorConsent.count({ where: { tutorId, channel: 'SERVICE_LIABILITY' } }),
    ).toBe(0)
  })
})

describe('MOD-DOC-08 — autorização de uso de imagem', () => {
  it('AC-01: o visto do cadastro já é prova; o aceite emite o papel que faltava', async () => {
    // O formulário de tutor grava `IMAGE_USE` sem documento — emitir PDF no cadastro
    // exigiria o endereço do estabelecimento e derrubaria o cadastro de quem não o tem.
    const cadastro = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/tutors',
      payload: {
        fullName: 'João Souza',
        phone: '11987654322',
        consents: { whatsapp: false, email: false, terms: true, imageUse: true },
      },
    })
    const outroTutor = cadastro.json().id

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${outroTutor}/term-acceptances`,
      payload: { kind: 'IMAGE_USE' },
    })

    // 200, e não 201: a prova já existia e o que faltava era o papel.
    expect(response.statusCode).toBe(200)
    expect(response.json().documentNumber).toMatch(/^IM-\d{4}\/\d{6}$/)
    expect(
      await ownerPrisma.tutorConsent.count({ where: { tutorId: outroTutor, channel: 'IMAGE_USE' } }),
    ).toBe(1)
  })

  it('o documento nomeia os animais do tutor no dia do aceite', async () => {
    const pet = await ownerPrisma.pet.create({
      data: {
        tenantId: tenant.tenantId,
        name: 'Thor',
        species: { connect: { id: await someSpeciesId() } },
        size: { connect: { id: await someSizeId() } },
      },
    })
    await ownerPrisma.petTutor.create({
      data: { tenantId: tenant.tenantId, petId: pet.id, tutorId, role: 'PRIMARY' },
    })

    await aceitar({ kind: 'IMAGE_USE' })

    expect(pdf.calls[0]).toContain('Thor')
  })
})

describe('MOD-DOC-11 — degradação e reprocesso', () => {
  it('Gotenberg fora do ar deixa o aceite gravado e o papel pendente', async () => {
    pdf.failWith = new PdfUnavailableError('gotenberg fora do ar')

    const response = await aceitar({ kind: 'SERVICE_LIABILITY' })

    // O aceite é o que tem valor jurídico: ele entra mesmo sem impressora.
    expect(response.statusCode).toBe(201)
    expect(response.json().documentStatus).toBe('PENDING')
    expect(
      await ownerPrisma.tutorConsent.count({ where: { tutorId, channel: 'SERVICE_LIABILITY' } }),
    ).toBe(1)
  })

  it('o job reprocessa quando o Gotenberg volta, com o texto da versão aceita', async () => {
    pdf.failWith = new PdfUnavailableError('gotenberg fora do ar')
    const aceite = await aceitar({ kind: 'SERVICE_LIABILITY' })
    const documentId = aceite.json().documentId

    // Uma versão nova é publicada antes do reprocesso: o papel tem de sair com o texto
    // que foi apresentado, e não com o de hoje.
    await publicar({
      kind: 'SERVICE_LIABILITY',
      version: '2.0',
      title: 'Termo de responsabilidade',
      body: '## Nova redação\n\nEste texto não pode aparecer no papel do aceite anterior.',
    })

    pdf.failWith = null
    const resultado = await retryPendingTermDocuments()

    expect(resultado.issued).toBe(1)
    expect(pdf.calls[0]).not.toContain('Nova redação')
    expect(pdf.calls[0]).toContain('ciência de riscos')

    const document = await ownerPrisma.document.findFirstOrThrow({ where: { id: documentId } })
    expect(document.status).toBe('ISSUED')
    expect(document.checksum).toHaveLength(64)
  })

  it('reprocessa o papel do aceite que veio do cadastro, sem vínculo na linha', async () => {
    // O visto do formulário grava a prova sem documento; o papel pedido depois nasce
    // solto, porque a linha de consentimento é imutável e não recebe a ligação.
    pdf.failWith = new PdfUnavailableError('gotenberg fora do ar')

    const cadastro = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/tutors',
      payload: {
        fullName: 'Carla Nunes',
        phone: '11987654323',
        consents: { whatsapp: false, email: false, terms: true, imageUse: true },
      },
    })
    const outroTutor = cadastro.json().id

    const pedido = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${outroTutor}/term-acceptances`,
      payload: { kind: 'IMAGE_USE' },
    })
    expect(pedido.json().documentStatus).toBe('PENDING')

    pdf.failWith = null
    expect((await retryPendingTermDocuments()).issued).toBe(1)

    const document = await ownerPrisma.document.findFirstOrThrow({
      where: { id: pedido.json().documentId },
    })
    expect(document.status).toBe('ISSUED')
  })

  it('a lista não assina nada; o detalhe assina e registra o download', async () => {
    const aceite = await aceitar({ kind: 'SERVICE_LIABILITY' })
    const documentId = aceite.json().documentId

    const lista = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutorId}/documents`,
    })
    expect(lista.json().documents).toHaveLength(1)
    expect(lista.json().documents[0].url).toBeNull()

    const detalhe = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutorId}/documents/${documentId}`,
    })
    expect(detalhe.json().url).toContain('assinada=1')

    const trilha = await ownerPrisma.auditLog.findMany({
      where: { tenantId: tenant.tenantId, action: 'document.downloaded' },
    })
    expect(trilha).toHaveLength(1)
  })
})

/** O catálogo de porte é global, como o de espécie. */
async function someSizeId(): Promise<string> {
  const existente = await ownerPrisma.size.findFirst({ where: { tenantId: null } })
  if (existente) return existente.id

  const criado = await ownerPrisma.size.create({
    data: { key: 'MEDIUM', label: 'Médio', weightMinKg: 10, weightMaxKg: 25, sortOrder: 2 },
  })
  return criado.id
}

/** O catálogo de espécies é global e semeado pela plataforma; aqui basta uma. */
async function someSpeciesId(): Promise<string> {
  const existente = await ownerPrisma.species.findFirst({ where: { tenantId: null } })
  if (existente) return existente.id

  const criada = await ownerPrisma.species.create({
    data: { key: 'DOG', label: 'Cão', sortOrder: 1 },
  })
  return criada.id
}
