import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/** MOD-TUTOR-09 (merge) e MOD-TUTOR-07 (visão 360º e portabilidade). */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

async function createTutor(payload: Record<string, unknown>) {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/tutors',
    payload: { consents: { whatsapp: true, email: true, terms: true }, ...payload },
  })
  if (response.statusCode !== 201) throw new Error(`cenário falhou: ${response.body}`)
  return response.json()
}

function merge(targetId: string, body: Record<string, unknown>) {
  return callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: `/v1/tutors/${targetId}/merge`,
    payload: { confirmation: 'CONFIRMO_A_UNIFICACAO', ...body },
  })
}

describe('MOD-TUTOR-09 — merge de duplicatas', () => {
  it('AC-01: unifica em uma transação, marca a origem e grava o log', async () => {
    const target = await createTutor({ fullName: 'Maria Silva', phone: '11987654321' })
    const source = await createTutor({
      fullName: 'Maria do Thor',
      phone: '11955554444',
      duplicateAcknowledged: true,
    })

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${source.id}/addresses`,
      payload: {
        zipCode: '01310100',
        street: 'Avenida Paulista',
        number: '1000',
        district: 'Bela Vista',
        city: 'São Paulo',
        state: 'SP',
      },
    })

    const response = await merge(target.id, {
      sourceId: source.id,
      fieldResolution: { phone: 'source' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ targetId: target.id, sourceId: source.id })

    const [origem, destino] = await Promise.all([
      ownerPrisma.tutor.findFirstOrThrow({ where: { id: source.id } }),
      ownerPrisma.tutor.findFirstOrThrow({ where: { id: target.id } }),
    ])

    // A origem vira ponteiro; quem tiver o id antigo ainda chega a algum lugar.
    expect(origem.status).toBe('MERGED')
    expect(origem.mergedIntoId).toBe(target.id)
    expect(destino.status).toBe('ACTIVE')

    // `fieldResolution` levou o telefone da origem para o destino.
    const detalhe = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${target.id}`,
    })
    expect(detalhe.json().phoneMasked).toBe('(11) *****-4444')
    expect(detalhe.json().addresses).toHaveLength(1)

    const log = await ownerPrisma.tutorMergeLog.findFirstOrThrow({
      where: { sourceId: source.id, targetId: target.id },
    })
    expect(log.snapshot).toHaveProperty('source')
    expect(log.movedEntities).toHaveProperty('addresses')
  })

  it('AC-03: os saldos são somados, nunca sobrescritos', async () => {
    const target = await createTutor({ fullName: 'Maria Silva', phone: '11987654321' })
    const source = await createTutor({
      fullName: 'Maria S.',
      phone: '11955554444',
      duplicateAcknowledged: true,
    })

    await ownerPrisma.tutor.update({ where: { id: target.id }, data: { balanceCents: 5_000 } })
    await ownerPrisma.tutor.update({ where: { id: source.id }, data: { balanceCents: -12_000 } })

    await merge(target.id, { sourceId: source.id })

    const destino = await ownerPrisma.tutor.findFirstOrThrow({ where: { id: target.id } })
    expect(destino.balanceCents).toBe(-7_000)
  })

  it('AC-02: origem igual ao destino, ou lado já terminal, é 422', async () => {
    const target = await createTutor({ fullName: 'Maria Silva', phone: '11987654321' })
    const source = await createTutor({
      fullName: 'Maria S.',
      phone: '11955554444',
      duplicateAcknowledged: true,
    })

    expect((await merge(target.id, { sourceId: target.id })).statusCode).toBe(422)

    await merge(target.id, { sourceId: source.id })
    // A origem já está MERGED: repetir o merge é 422.
    const repetido = await merge(target.id, { sourceId: source.id })
    expect(repetido.statusCode).toBe(422)
    expect(repetido.json().code).toBe('ERR_TUTOR_007')
  })

  it('libera o CPF da origem, para o destino poder ficar com ele', async () => {
    const target = await createTutor({ fullName: 'Maria Silva', phone: '11987654321' })
    const source = await createTutor({
      fullName: 'Maria S.',
      phone: '11955554444',
      cpf: '52998224725',
      duplicateAcknowledged: true,
    })

    await merge(target.id, { sourceId: source.id, fieldResolution: { cpf: 'source' } })

    const destino = await ownerPrisma.tutor.findFirstOrThrow({ where: { id: target.id } })
    const origem = await ownerPrisma.tutor.findFirstOrThrow({ where: { id: source.id } })
    expect(destino.cpfHash).not.toBeNull()
    expect(origem.cpfHash).toBeNull()

    // E a busca pelo CPF agora encontra o destino.
    const busca = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors?q=52998224725',
    })
    expect(busca.json().total).toBe(1)
    expect(busca.json().data[0].id).toBe(target.id)
  })

  it('a origem mesclada some da listagem e recusa escrita', async () => {
    const target = await createTutor({ fullName: 'Maria Silva', phone: '11987654321' })
    const source = await createTutor({
      fullName: 'Maria S.',
      phone: '11955554444',
      duplicateAcknowledged: true,
    })
    await merge(target.id, { sourceId: source.id })

    const lista = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/tutors' })
    expect(lista.json().total).toBe(1)

    const edicao = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/tutors/${source.id}`,
      payload: { fullName: 'Outro Nome' },
    })
    expect(edicao.statusCode).toBe(409)
    expect(edicao.json().code).toBe('ERR_TUTOR_006')
  })
})

describe('MOD-TUTOR-07 — visão 360º e portabilidade', () => {
  it('a visão 360º declara os módulos que ainda não existem', async () => {
    const tutor = await createTutor({ fullName: 'Maria Silva', phone: '11987654321' })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutor.id}/overview`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.tutor.id).toBe(tutor.id)
    // Vazio e "ainda não disponível" são coisas diferentes, e a UI precisa saber qual é.
    // MOD-PET saiu da lista: os pets existem, e a tela do tutor os busca no pet-service.
    expect(body.pendingModules).toEqual(['MOD-AGENDA', 'MOD-LEDGER', 'MOD-CRM'])
  })

  it('a exportação LGPD traz a PII em claro e fica auditada', async () => {
    const tutor = await createTutor({
      fullName: 'Maria Silva',
      phone: '11987654321',
      cpf: '52998224725',
      email: 'maria@exemplo.com',
      notes: 'Chega sempre atrasada',
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutor.id}/export`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.tutor).toMatchObject({
      cpf: '52998224725',
      phone: '+5511987654321',
      email: 'maria@exemplo.com',
      notes: 'Chega sempre atrasada',
    })
    expect(body.consents).toHaveLength(4)

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { action: 'tutor.exported', entityId: tutor.id },
    })
    expect(audit).not.toBeNull()
  })

  it('ler o documento completo gera `tutor.cpf_revealed`', async () => {
    const tutor = await createTutor({
      fullName: 'Maria Silva',
      phone: '11987654321',
      cpf: '52998224725',
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutor.id}/sensitive`,
    })

    expect(response.json().cpf).toBe('52998224725')
    const audit = await ownerPrisma.auditLog.findFirst({
      where: { action: 'tutor.cpf_revealed', entityId: tutor.id },
    })
    expect(audit).not.toBeNull()
  })
})
