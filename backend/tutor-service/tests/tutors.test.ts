import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * MOD-TUTOR-01 (CRUD), MOD-TUTOR-02 (deduplicação) e MOD-TUTOR-08 (exclusão e
 * anonimização), verificados pelos critérios de aceite do PRD tutores_02 §3.
 */

let tenant: TenantFixture

const maria = {
  fullName: 'Maria Silva',
  phone: '(11) 98765-4321',
  cpf: '529.982.247-25',
  email: 'maria@exemplo.com',
  birthDate: '1988-04-12',
  consents: { whatsapp: true, email: true, terms: true },
}

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function createTutor(payload: Record<string, unknown>) {
  return callApi({ ...asAdmin(tenant), method: 'POST', url: '/v1/tutors', payload })
}

describe('MOD-TUTOR-01 — CRUD de tutor', () => {
  it('AC-01: normaliza, cifra, registra consentimento e devolve CPF mascarado', async () => {
    const response = await createTutor(maria)

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.cpfMasked).toBe('***.***.247-25')
    expect(body.phoneMasked).toBe('(11) *****-4321')
    expect(body.status).toBe('ACTIVE')
    expect(body.email).toBe('maria@exemplo.com')

    // O telefone foi para E.164 e o CPF está cifrado no banco, não em claro.
    const row = await ownerPrisma.tutor.findFirstOrThrow({ where: { id: body.id } })
    expect(row.cpfEncrypted).toMatch(/^v1:/)
    expect(row.cpfEncrypted).not.toContain('52998224725')
    expect(row.phoneEncrypted).toMatch(/^v1:/)

    // Um registro de consentimento por canal, com a prova de origem.
    const consents = await ownerPrisma.tutorConsent.findMany({ where: { tutorId: body.id } })
    expect(consents.map((c) => c.channel).sort()).toEqual([
      'EMAIL',
      'IMAGE_USE',
      'TERMS',
      'WHATSAPP',
    ])
    expect(consents.every((c) => c.source === 'STAFF_FORM')).toBe(true)
  })

  it('AC-02: CPF com dígito verificador inválido é 422 ERR_TUTOR_002 com o campo', async () => {
    const response = await createTutor({ ...maria, cpf: '11111111111' })

    expect(response.statusCode).toBe(422)
    const problem = response.json()
    expect(problem.code).toBe('ERR_TUTOR_002')
    expect(problem.errors).toContainEqual({ field: 'cpf', message: 'CPF inválido' })
  })

  it('AC-03: PF sem CPF é aceita como PARTIAL', async () => {
    const response = await createTutor({
      fullName: 'Cliente de Balcão',
      phone: '11988887777',
      consents: { whatsapp: true, email: false, terms: true },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().dataCompleteness).toBe('PARTIAL')
    expect(response.json().cpfMasked).toBeNull()
  })

  it('AC-04: PJ sem CNPJ ou sem razão social é 422', async () => {
    const response = await createTutor({
      ...maria,
      personType: 'PJ',
      cpf: undefined,
      fullName: 'Pet Shop do Bairro',
    })

    expect(response.statusCode).toBe(422)
    const fields = response.json().errors.map((e: { field: string }) => e.field)
    expect(fields).toContain('cnpj')
  })

  it('marca COMPLETE quando o cadastro tem documento e endereço', async () => {
    const response = await createTutor({
      ...maria,
      address: {
        zipCode: '01310100',
        street: 'Avenida Paulista',
        number: '1000',
        district: 'Bela Vista',
        city: 'São Paulo',
        state: 'sp',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.dataCompleteness).toBe('COMPLETE')
    expect(body.addresses).toHaveLength(1)
    expect(body.addresses[0]).toMatchObject({ state: 'SP', isPrimary: true })

    // Logradouro e número cifrados; bairro e cidade em claro (PRD §4).
    const address = await ownerPrisma.tutorAddress.findFirstOrThrow({ where: { tutorId: body.id } })
    expect(address.streetEncrypted).toMatch(/^v1:/)
    expect(address.city).toBe('São Paulo')
  })

  it('RN-14: o nome social é o nome exibido', async () => {
    const response = await createTutor({ ...maria, socialName: 'Mari' })
    expect(response.json()).toMatchObject({ fullName: 'Maria Silva', displayName: 'Mari' })
  })

  it('atualiza parcialmente e distingue limpar de não enviar', async () => {
    const created = await createTutor(maria)
    const id = created.json().id

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/tutors/${id}`,
      payload: { email: null, notes: 'Prefere sábado de manhã' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().email).toBeNull()
    expect(response.json().notes).toBe('Prefere sábado de manhã')
    // O telefone não foi enviado e continua lá.
    expect(response.json().phoneMasked).toBe('(11) *****-4321')
  })

  it('404 para tutor de outro tenant — o RLS não deixa atravessar', async () => {
    const created = await createTutor(maria)
    const other = await givenTenant('Outro Petshop')

    const response = await callApi({
      ...asAdmin(other),
      method: 'GET',
      url: `/v1/tutors/${created.json().id}`,
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_TUTOR_001')
  })

  it('nega quem não tem a permissão, com 403 auditado', async () => {
    const response = await callApi({
      clerkUserId: tenant.clerkUserId,
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      role: 'BATHER',
      permissions: ['tutor:read'],
      method: 'POST',
      url: '/v1/tutors',
      payload: maria,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_TUTOR_003')

    const denied = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: tenant.tenantId, action: 'auth.permission_denied' },
    })
    expect(denied?.outcome).toBe('DENIED')
  })
})

describe('MOD-TUTOR-02 — deduplicação', () => {
  it('AC-01: CPF repetido é 409 ERR_TUTOR_004 com o cadastro existente', async () => {
    const first = await createTutor(maria)

    const response = await createTutor({
      ...maria,
      fullName: 'Maria S. Silva',
      phone: '11955554444',
      email: 'outro@exemplo.com',
      duplicateAcknowledged: true,
    })

    expect(response.statusCode).toBe(409)
    const problem = response.json()
    expect(problem.code).toBe('ERR_TUTOR_004')
    expect(problem.existingTutor).toMatchObject({
      id: first.json().id,
      fullName: 'Maria Silva',
      suggestedAction: 'OPEN_EXISTING',
    })
    expect(problem.existingTutor.phoneMasked).toBe('(11) *****-4321')
  })

  it('AC-03 e RN-02: telefone repetido alerta, mas não bloqueia', async () => {
    await createTutor(maria)

    // Sem o flag: 409 com os candidatos, pedindo confirmação.
    const warned = await createTutor({
      fullName: 'José Silva',
      phone: maria.phone,
      consents: { whatsapp: true, email: false, terms: true },
    })
    expect(warned.statusCode).toBe(409)
    expect(warned.json().requiresAcknowledgement).toBe(true)
    expect(warned.json().candidates[0]).toMatchObject({ matchedOn: ['phone'], confidence: 'MEDIUM' })

    // Com o flag: o cadastro do segundo responsável passa.
    const accepted = await createTutor({
      fullName: 'José Silva',
      phone: maria.phone,
      consents: { whatsapp: true, email: false, terms: true },
      duplicateAcknowledged: true,
    })
    expect(accepted.statusCode).toBe(201)

    // E o override fica registrado (PRD §9).
    const override = await ownerPrisma.auditLog.findFirst({
      where: { action: 'tutor.duplicate_override' },
    })
    expect(override).not.toBeNull()
  })

  it('AC-02: check-duplicates aponta nome semelhante com contato em comum', async () => {
    await createTutor(maria)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/tutors/check-duplicates',
      payload: { fullName: 'Maria da Silva', email: 'maria@exemplo.com' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.confidence).toBe('MEDIUM')
    expect(body.candidates[0].matchedOn).toContain('email')
    expect(body.candidates[0].matchedOn).toContain('name')
  })

  it('AC-04: CPF de tutor inativo sugere reativar, preservando o histórico', async () => {
    const created = await createTutor(maria)
    const id = created.json().id

    await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/tutors/${id}`,
      payload: { status: 'INACTIVE' },
    })

    const response = await createTutor({ ...maria, duplicateAcknowledged: true })
    expect(response.statusCode).toBe(409)
    expect(response.json().existingTutor).toMatchObject({
      id,
      status: 'INACTIVE',
      suggestedAction: 'REACTIVATE_EXISTING',
    })

    const reactivated = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${id}/reactivate`,
    })
    expect(reactivated.statusCode).toBe(200)
    expect(reactivated.json().status).toBe('ACTIVE')
  })

  it('RN-01: o mesmo CPF pode existir em dois tenants', async () => {
    await createTutor(maria)
    const other = await givenTenant('Petshop Vizinho')

    const response = await callApi({
      ...asAdmin(other),
      method: 'POST',
      url: '/v1/tutors',
      payload: maria,
    })

    expect(response.statusCode).toBe(201)
  })
})

describe('MOD-TUTOR-08 — exclusão e anonimização', () => {
  it('AC-01: tutor sem histórico é soft-deleted e some da listagem', async () => {
    const created = await createTutor(maria)
    const id = created.json().id

    const response = await callApi({ ...asAdmin(tenant), method: 'DELETE', url: `/v1/tutors/${id}` })
    expect(response.statusCode).toBe(204)

    const list = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/tutors' })
    expect(list.json().total).toBe(0)

    const row = await ownerPrisma.tutor.findFirstOrThrow({ where: { id } })
    expect(row.deletedAt).not.toBeNull()
  })

  it('AC-02: histórico financeiro bloqueia a exclusão com ERR_TUTOR_005', async () => {
    const created = await createTutor(maria)
    const id = created.json().id
    await ownerPrisma.tutor.update({ where: { id }, data: { balanceCents: -12_000 } })

    const response = await callApi({ ...asAdmin(tenant), method: 'DELETE', url: `/v1/tutors/${id}` })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TUTOR_005')
    expect(response.json().anonymizePath).toBe(`/v1/tutors/${id}/anonymize`)
  })

  it('AC-03: anonimização apaga a PII, preserva a prova de consentimento e é irreversível', async () => {
    const created = await createTutor({
      ...maria,
      address: {
        zipCode: '01310100',
        street: 'Avenida Paulista',
        number: '1000',
        district: 'Bela Vista',
        city: 'São Paulo',
        state: 'SP',
      },
    })
    const id = created.json().id

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${id}/anonymize`,
      payload: {
        confirmation: 'CONFIRMO_A_ANONIMIZACAO',
        reason: 'Pedido do titular por e-mail em 20/08/2026',
      },
    })
    expect(response.statusCode).toBe(204)

    const row = await ownerPrisma.tutor.findFirstOrThrow({ where: { id } })
    expect(row.fullName).toMatch(/^Tutor Anonimizado #[0-9A-F]{4}$/)
    expect(row.cpfEncrypted).toBeNull()
    expect(row.emailEncrypted).toBeNull()
    expect(row.status).toBe('ANONYMIZED')
    expect(row.anonymizedAt).not.toBeNull()

    // Endereço apagado; consentimento preservado — é prova com retenção própria.
    expect(await ownerPrisma.tutorAddress.count({ where: { tutorId: id } })).toBe(0)
    expect(await ownerPrisma.tutorConsent.count({ where: { tutorId: id } })).toBe(4)

    // Irreversível: qualquer escrita posterior é 409.
    const edit = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/tutors/${id}`,
      payload: { fullName: 'Maria Silva' },
    })
    expect(edit.statusCode).toBe(409)
    expect(edit.json().code).toBe('ERR_TUTOR_006')
  })

  it('exige a frase de dupla confirmação (RN-08)', async () => {
    const created = await createTutor(maria)
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/${created.json().id}/anonymize`,
      payload: { confirmation: 'sim', reason: 'Pedido do titular por e-mail' },
    })
    expect(response.statusCode).toBe(422)
  })
})
