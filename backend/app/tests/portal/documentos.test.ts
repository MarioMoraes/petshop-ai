import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { setStoragePort } from '../../src/shared/document-storage.js'
import {
  asTutor,
  asVisitor,
  callApi,
  closeHarness,
  fakeTutorService,
  givenConsent,
  givenDocument,
  givenPet,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
  type TutorServiceDouble,
} from './fixtures.js'

/**
 * MOD-DOC-10 — Meus Documentos, e os termos do lado do cliente (MOD-DOC-07 AC-02).
 *
 * A emissão de cada documento tem suíte própria no serviço que sabe montá-lo. O que
 * **esta** guarda é o que o Portal acrescenta:
 *
 * - o recorte por titular, na consulta e não depois dela (AC-02);
 * - o que a lista **não** mostra: documento sem titular é do estabelecimento (AC-03);
 * - o download que vai para a trilha, e a assinatura que só existe no salto;
 * - o aceite que chega ao tutor-service marcado como vindo do Portal — porque é prova.
 */

let fixture: TenantFixture
let tutorService: TutorServiceDouble
let assinadas: string[]

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  tutorService = fakeTutorService(fixture)

  assinadas = []
  /**
   * O bucket dos documentos, dublado inteiro.
   *
   * Antes da fatia 11 o Portal tinha uma porta só de leitura e o dublê tinha um método só.
   * Hoje ele assina pelo mesmo `shared/document-storage.ts` que o MOD-LEDGER e o MOD-PRONT
   * usam para **gravar**, e o dublê precisa da interface inteira. `put` e `read` lançam de
   * propósito: nenhum caminho do Portal escreve documento, e um teste que passasse a
   * escrever precisa falhar aqui em vez de gravar num Map invisível.
   */
  setStoragePort({
    async signedUrl(key: string) {
      assinadas.push(key)
      return `https://bucket.example/${key}?assinatura=x`
    },
    async put() {
      throw new Error('o Portal não grava documento')
    },
    async read() {
      throw new Error('o Portal não lê bytes de documento')
    },
  })
})

afterAll(async () => {
  setStoragePort(null)
  await closeHarness()
})

describe('GET /portal/v1/documents', () => {
  it('AC-01: lista os documentos do titular, do mais recente para o mais antigo', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId, { name: 'Thor' })

    await givenDocument(fixture, {
      tutorId,
      kind: 'RECEIPT',
      number: '2026/000001',
      issuedAt: new Date('2026-08-01T12:00:00Z'),
    })
    await givenDocument(fixture, {
      tutorId,
      kind: 'PRESCRIPTION',
      number: 'RX-2026/000004',
      petId,
      issuedAt: new Date('2026-09-01T12:00:00Z'),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/documents',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const { documents } = response.json()
    expect(documents).toHaveLength(2)
    expect(documents[0].number).toBe('RX-2026/000004')
    // O pet é o que separa dois receituários na mesma lista.
    expect(documents[0].petName).toBe('Thor')
    expect(documents[0].ready).toBe(true)
    // A listagem não assina nada: abrir a lista não é baixar dois arquivos.
    expect(assinadas).toEqual([])
  })

  it('AC-03: documento sem titular é do estabelecimento e não entra na lista', async () => {
    const tutorId = await givenTutor(fixture)
    await givenDocument(fixture, { tutorId: null, kind: 'RECEIPT', number: '2026/000009' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/documents',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().documents).toEqual([])
  })

  it('documento de outro titular não aparece, nem no mesmo estabelecimento', async () => {
    const tutorId = await givenTutor(fixture)
    const outro = await givenTutor(fixture, { phone: '+5511999996666' })
    await givenDocument(fixture, { tutorId: outro, kind: 'RECEIPT', number: '2026/000002' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/documents',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().documents).toEqual([])
  })

  it('o documento em preparo aparece sem link, e não some da lista', async () => {
    const tutorId = await givenTutor(fixture)
    await givenDocument(fixture, {
      tutorId,
      kind: 'RECEIPT',
      number: '2026/000003',
      status: 'PENDING',
    })

    const { documents } = (
      await callApi({ method: 'GET', url: '/portal/v1/documents', ...asTutor(fixture, tutorId) })
    ).json()

    expect(documents).toHaveLength(1)
    expect(documents[0].ready).toBe(false)
  })

  it('documento cancelado sai da lista: é papel sem efeito', async () => {
    const tutorId = await givenTutor(fixture)
    await givenDocument(fixture, {
      tutorId,
      kind: 'RECEIPT',
      number: '2026/000004',
      status: 'CANCELLED',
    })

    const { documents } = (
      await callApi({ method: 'GET', url: '/portal/v1/documents', ...asTutor(fixture, tutorId) })
    ).json()

    expect(documents).toEqual([])
  })
})

describe('GET /portal/v1/documents/:documentId', () => {
  it('AC-01: devolve a URL assinada e registra o download na trilha', async () => {
    const tutorId = await givenTutor(fixture)
    const documentId = await givenDocument(fixture, {
      tutorId,
      kind: 'TERM_ACCEPTANCE',
      number: 'TR-2026/000001',
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/documents/${documentId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().url).toContain('assinatura=x')
    expect(assinadas).toHaveLength(1)

    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId, action: 'document.downloaded' },
    })
    expect(trilha?.entityId).toBe(documentId)
  })

  it('AC-02: o documento de outro titular responde 404, como o que não existe', async () => {
    const tutorId = await givenTutor(fixture)
    const outro = await givenTutor(fixture, { phone: '+5511999995555' })
    const alheio = await givenDocument(fixture, {
      tutorId: outro,
      kind: 'RECEIPT',
      number: '2026/000005',
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/documents/${alheio}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_PORTAL_001')
    // Nem chegou a assinar: o que não é dele não sai do banco.
    expect(assinadas).toEqual([])
  })

  it('documento em preparo devolve o número sem URL, e não um link morto', async () => {
    const tutorId = await givenTutor(fixture)
    const documentId = await givenDocument(fixture, {
      tutorId,
      kind: 'RECEIPT',
      number: '2026/000006',
      status: 'PENDING',
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/documents/${documentId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().url).toBeNull()
    expect(response.json().number).toBe('2026/000006')

    // Sem arquivo não houve download, e a trilha não registra intenção.
    const trilha = await ownerPrisma.auditLog.count({
      where: { tenantId: fixture.tenantId, action: 'document.downloaded' },
    })
    expect(trilha).toBe(0)
  })
})

describe('GET /portal/v1/terms', () => {
  it('traz os três termos vigentes, com o texto que o tutor vai ler', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/terms',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const { terms } = response.json()
    expect(terms.map((t: { kind: string }) => t.kind)).toEqual([
      'TERMS',
      'SERVICE_LIABILITY',
      'IMAGE_USE',
    ])
    expect(terms.every((t: { accepted: boolean }) => !t.accepted)).toBe(true)
    expect(terms[1].body.length).toBeGreaterThan(200)
  })

  it('marca como aceito o que este tutor aceitou na versão vigente', async () => {
    const tutorId = await givenTutor(fixture)
    await givenConsent(fixture, tutorId, { channel: 'SERVICE_LIABILITY', granted: true })

    const { terms } = (
      await callApi({ method: 'GET', url: '/portal/v1/terms', ...asTutor(fixture, tutorId) })
    ).json()

    const responsabilidade = terms.find(
      (t: { kind: string }) => t.kind === 'SERVICE_LIABILITY',
    )
    expect(responsabilidade.accepted).toBe(true)
    expect(responsabilidade.acceptedVersion).toBe('1.0')
  })

  it('aceite de versão anterior não conta como aceito — há texto novo a apresentar', async () => {
    const tutorId = await givenTutor(fixture)
    await givenConsent(fixture, tutorId, {
      channel: 'IMAGE_USE',
      granted: true,
      version: '0.9',
    })

    const { terms } = (
      await callApi({ method: 'GET', url: '/portal/v1/terms', ...asTutor(fixture, tutorId) })
    ).json()

    const imagem = terms.find((t: { kind: string }) => t.kind === 'IMAGE_USE')
    expect(imagem.accepted).toBe(false)
    expect(imagem.acceptedVersion).toBe('0.9')
  })

  it('revogação apaga o aceite da tela, e o histórico continua no banco', async () => {
    const tutorId = await givenTutor(fixture)
    await givenConsent(fixture, tutorId, { channel: 'IMAGE_USE', granted: true })
    await givenConsent(fixture, tutorId, {
      channel: 'IMAGE_USE',
      granted: false,
      createdAt: new Date(Date.now() + 1000),
    })

    const { terms } = (
      await callApi({ method: 'GET', url: '/portal/v1/terms', ...asTutor(fixture, tutorId) })
    ).json()

    const imagem = terms.find((t: { kind: string }) => t.kind === 'IMAGE_USE')
    expect(imagem.accepted).toBe(false)
    expect(imagem.acceptedVersion).toBeNull()
    expect(await ownerPrisma.tutorConsent.count({ where: { tutorId } })).toBe(2)
  })
})

describe('POST /portal/v1/terms/:kind/accept', () => {
  it('AC-02 de MOD-DOC-07: o aceite vai ao tutor-service marcado como vindo do Portal', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/terms/SERVICE_LIABILITY/accept',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(204)
    expect(tutorService.terms).toEqual([
      expect.objectContaining({ tutorId, term: 'SERVICE_LIABILITY', source: 'PORTAL' }),
    ])

    // A prova é a linha, e ela nasceu de verdade.
    const consent = await ownerPrisma.tutorConsent.findFirst({
      where: { tutorId, channel: 'SERVICE_LIABILITY' },
    })
    expect(consent?.granted).toBe(true)
    expect(consent?.source).toBe('PORTAL')
  })

  it('o IP do tutor chega à porta — é ele que vira prova, não o do contêiner', async () => {
    const tutorId = await givenTutor(fixture)

    await callApi({
      method: 'POST',
      url: '/portal/v1/terms/IMAGE_USE/accept',
      ...asTutor(fixture, tutorId),
      headers: { 'x-forwarded-for': '200.1.2.3' },
    })

    expect(tutorService.terms[0]?.ipAddress).toBe('200.1.2.3')
  })

  it('tipo de termo desconhecido é 422, e a porta nem é chamada', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/terms/QUALQUER_COISA/accept',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(422)
    expect(tutorService.terms).toEqual([])
  })

  it('quem entrou no Clerk mas não vinculou ficha não alcança as rotas', async () => {
    const lista = await callApi({
      method: 'GET',
      url: '/portal/v1/documents',
      ...asVisitor(fixture),
    })
    expect(lista.statusCode).toBe(403)

    const aceite = await callApi({
      method: 'POST',
      url: '/portal/v1/terms/IMAGE_USE/accept',
      ...asVisitor(fixture),
    })
    expect(aceite.statusCode).toBe(403)
    expect(tutorService.terms).toEqual([])
  })
})
