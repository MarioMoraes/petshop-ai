import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  closeHarness,
  fakeCep,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  resetFakeCep,
  type TenantFixture,
} from './harness.js'
import {
  handleAtendimentoConcluido,
  handleInadimplenciaDetectada,
  handleInadimplenciaResolvida,
  handleLancamentoCriado,
  handlePetCriado,
  handlePetVinculoAlterado,
} from '../src/modules/tutors/consumers.js'

/** MOD-TUTOR-03 (endereço) e MOD-TUTOR-05 (tags e segmentação). */

let tenant: TenantFixture
let tutorId: string

const endereco = {
  zipCode: '01310100',
  street: 'Avenida Paulista',
  number: '1000',
  district: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
}

beforeEach(async () => {
  await resetDatabase()
  resetFakeCep()
  tenant = await givenTenant()

  const created = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/tutors',
    payload: {
      fullName: 'Maria Silva',
      phone: '11987654321',
      consents: { whatsapp: true, email: true, terms: true },
    },
  })
  tutorId = created.json().id
})

afterAll(closeHarness)

describe('MOD-TUTOR-03 — endereços', () => {
  it('o primeiro endereço vira o principal, mesmo sem pedir', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${tutorId}/addresses`,
      payload: { ...endereco, isPrimary: false },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().isPrimary).toBe(true)
  })

  it('RN-15: promover um endereço rebaixa o anterior na mesma transação', async () => {
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${tutorId}/addresses`,
      payload: endereco,
    })
    const segundo = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${tutorId}/addresses`,
      payload: { ...endereco, label: 'Trabalho', number: '2000', isPrimary: true },
    })

    expect(segundo.json().isPrimary).toBe(true)

    const lista = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutorId}/addresses`,
    })
    const principais = lista.json().filter((a: { isPrimary: boolean }) => a.isPrimary)
    expect(principais).toHaveLength(1)
    expect(principais[0].label).toBe('Trabalho')
  })

  it('cifra logradouro e número, mantendo cidade e UF em claro', async () => {
    const created = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${tutorId}/addresses`,
      payload: endereco,
    })

    const row = await ownerPrisma.tutorAddress.findFirstOrThrow({
      where: { id: created.json().id },
    })
    expect(row.streetEncrypted).toMatch(/^v1:/)
    expect(row.streetEncrypted).not.toContain('Paulista')
    expect(row.city).toBe('São Paulo')
    // E volta decifrado na API.
    expect(created.json().street).toBe('Avenida Paulista')
  })

  it('consulta de CEP preenche o endereço', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors/cep-lookup?cep=01310-100',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      street: 'Avenida Paulista',
      city: 'São Paulo',
      state: 'SP',
    })
  })

  it('CEP inexistente é 404, não erro de provedor', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors/cep-lookup?cep=99999999',
    })
    expect(response.statusCode).toBe(404)
  })

  it('provedor fora do ar vira ERR_TUTOR_008 — o cadastro segue manual', async () => {
    fakeCep.failWith = new Error('ECONNREFUSED')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors/cep-lookup?cep=01310100',
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().code).toBe('ERR_TUTOR_008')

    // E o endereço continua podendo ser gravado à mão.
    const manual = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${tutorId}/addresses`,
      payload: endereco,
    })
    expect(manual.statusCode).toBe(201)
  })
})

describe('MOD-TUTOR-05 — tags', () => {
  function createTag(key = 'VIP', label = 'VIP') {
    return callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/tutors/tags',
      payload: { key, label, color: '#E34A32' },
    })
  }

  it('AC-01: atribuição em lote é idempotente', async () => {
    const tag = await createTag()
    const tagId = tag.json().id

    const first = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/tags/${tagId}/assign`,
      payload: { tutorIds: [tutorId] },
    })
    expect(first.json()).toEqual({ assigned: 1, alreadyAssigned: 0 })

    const second = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/tags/${tagId}/assign`,
      payload: { tutorIds: [tutorId] },
    })
    expect(second.json()).toEqual({ assigned: 0, alreadyAssigned: 1 })

    const tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().tags).toEqual([
      { key: 'VIP', label: 'VIP', color: '#E34A32', isSystem: false },
    ])
  })

  it('AC-02: chave reservada ao sistema é recusada na criação', async () => {
    const response = await createTag('INATIVO', 'Inativo')
    expect(response.statusCode).toBe(422)
  })

  it('AC-02: atribuir tag de sistema à mão é 403', async () => {
    const created = await ownerPrisma.tutorTag.create({
      data: {
        tenantId: tenant.tenantId,
        key: 'INADIMPLENTE',
        label: 'Inadimplente',
        isSystem: true,
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/tags/${created.id}/assign`,
      payload: { tutorIds: [tutorId] },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_TUTOR_003')
  })

  it('remove tag manual e recusa remover a automática', async () => {
    const tag = await createTag()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/tags/${tag.json().id}/assign`,
      payload: { tutorIds: [tutorId] },
    })

    const removed = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/tutors/${tutorId}/tags/${tag.json().id}`,
    })
    expect(removed.statusCode).toBe(204)

    const system = await ownerPrisma.tutorTag.create({
      data: { tenantId: tenant.tenantId, key: 'INATIVO', label: 'Inativo', isSystem: true },
    })
    const blocked = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/tutors/${tutorId}/tags/${system.id}`,
    })
    expect(blocked.statusCode).toBe(403)
  })

  it('AC-03 e RN-10: concluir atendimento atualiza a data e tira a tag INATIVO', async () => {
    const inativo = await ownerPrisma.tutorTag.create({
      data: { tenantId: tenant.tenantId, key: 'INATIVO', label: 'Inativo', isSystem: true },
    })
    await ownerPrisma.tutorTagAssignment.create({
      data: { tenantId: tenant.tenantId, tutorId, tagId: inativo.id },
    })

    await handleAtendimentoConcluido({
      tenantId: tenant.tenantId,
      tutorId,
      concludedAt: '2026-08-20T14:00:00.000Z',
    })

    const tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().lastAttendanceAt).toBe('2026-08-20T14:00:00.000Z')
    expect(tutor.json().tags).toEqual([])
  })

  it('RN-10: `lancamento.criado` atualiza o saldo e **não** marca inadimplência', async () => {
    await handleLancamentoCriado({ tenantId: tenant.tenantId, tutorId, balanceCents: -12_000 })

    const tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().balance).toBe(-120)
    // Dever R$ 120 do banho de hoje não faz de ninguém inadimplente. Quem tomou banho
    // de manhã e paga na saída passaria o dia inteiro marcado — e a régua de cobrança
    // do MOD-CRM iria atrás dele. Quem decide é o atraso, não o sinal.
    expect(tutor.json().tags).toEqual([])
  })

  it('RN-16: a tag INADIMPLENTE segue os eventos de atraso, nos dois sentidos', async () => {
    await handleLancamentoCriado({ tenantId: tenant.tenantId, tutorId, balanceCents: -12_000 })
    await handleInadimplenciaDetectada({ tenantId: tenant.tenantId, tutorId })

    let tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().tags.map((t: { key: string }) => t.key)).toEqual(['INADIMPLENTE'])

    await handleInadimplenciaResolvida({ tenantId: tenant.tenantId, tutorId })

    tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().tags).toEqual([])
  })

  it('a reentrega do evento de inadimplência não duplica a tag', async () => {
    await handleInadimplenciaDetectada({ tenantId: tenant.tenantId, tutorId })
    await handleInadimplenciaDetectada({ tenantId: tenant.tenantId, tutorId })

    const tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().tags).toHaveLength(1)
  })

  it('RN-10: `petsCount` é recontado por MOD-PET e sobrevive à entrega repetida', async () => {
    const catalog = await givenPetCatalog()
    const petId = await givenPet(catalog, tutorId)

    await handlePetCriado({ tenantId: tenant.tenantId, primaryTutorId: tutorId })
    let tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().petsCount).toBe(1)

    // Entrega em duplicata: a recontagem é idempotente, um incremento não seria.
    await handlePetCriado({ tenantId: tenant.tenantId, primaryTutorId: tutorId })
    tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().petsCount).toBe(1)

    // Pet excluído sai da conta: a recontagem ignora `deleted_at`.
    await ownerPrisma.pet.update({ where: { id: petId }, data: { deletedAt: new Date() } })
    await handlePetVinculoAlterado({ tenantId: tenant.tenantId, tutorId })
    tutor = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors/${tutorId}` })
    expect(tutor.json().petsCount).toBe(0)
  })

  it('filtra a listagem por tag e por inadimplência', async () => {
    // O saldo vem do lançamento; a tag, do evento de atraso. São filtros diferentes
    // porque respondem a perguntas diferentes: "quem deve" e "quem está atrasado".
    await handleLancamentoCriado({ tenantId: tenant.tenantId, tutorId, balanceCents: -5_000 })
    await handleInadimplenciaDetectada({ tenantId: tenant.tenantId, tutorId })

    const porTag = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors?tag=INADIMPLENTE',
    })
    expect(porTag.json().total).toBe(1)

    const comDivida = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors?hasDebt=true',
    })
    expect(comDivida.json().total).toBe(1)

    const semDivida = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors?hasDebt=false',
    })
    expect(semDivida.json().total).toBe(0)
  })
})

/**
 * Pets criados direto no banco: quem cadastra é o pet-service, e chamá-lo daqui
 * acoplaria as duas suítes. O que o teste precisa é da linha existir para a
 * recontagem ter o que contar.
 */
async function givenPetCatalog() {
  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
  ])
  return { speciesId: species.id, sizeId: size.id }
}

async function givenPet(
  catalog: { speciesId: string; sizeId: string },
  linkedTutorId: string,
): Promise<string> {
  const pet = await ownerPrisma.pet.create({
    data: {
      tenantId: tenant.tenantId,
      name: 'Thor',
      speciesId: catalog.speciesId,
      sizeId: catalog.sizeId,
    },
  })
  await ownerPrisma.petTutor.create({
    data: { tenantId: tenant.tenantId, petId: pet.id, tutorId: linkedTutorId, role: 'PRIMARY' },
  })
  return pet.id
}
