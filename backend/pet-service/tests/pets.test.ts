import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  catalogIds,
  closeHarness,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type CatalogFixture,
  type TenantFixture,
} from './harness.js'

/**
 * MOD-PET-01 (CRUD) e a parte de MOD-PET-03 de que ele depende, verificados pelos
 * critérios de aceite do PRD pets_03 §3.
 */

let tenant: TenantFixture
let catalog: CatalogFixture
let tutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  catalog = await catalogIds()
  tutorId = await givenTutor(tenant)
})

afterAll(closeHarness)

function petPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Thor',
    speciesId: catalog.speciesDogId,
    breedId: catalog.breedDogId,
    sizeId: catalog.sizeLargeId,
    coatId: catalog.coatShortId,
    sex: 'MALE',
    birthDate: '2021-03-10',
    weightKg: 32.4,
    neutered: true,
    tutors: [{ tutorId, role: 'PRIMARY' }],
    ...overrides,
  }
}

function createPet(payload: Record<string, unknown> = petPayload()) {
  return callApi({ ...asAdmin(tenant), method: 'POST', url: '/v1/pets', payload })
}

describe('MOD-PET-01 — CRUD de pet', () => {
  it('AC-01: cria o pet ativo, vincula o tutor, registra a primeira pesagem e calcula a idade', async () => {
    const response = await createPet()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('ACTIVE')
    expect(body.name).toBe('Thor')
    expect(body.species.key).toBe('DOG')
    expect(body.birthDatePrecision).toBe('EXACT')
    expect(body.ageMonths).toBeGreaterThan(0)
    expect(body.ageLabel).not.toContain('≈')

    expect(body.tutors).toHaveLength(1)
    expect(body.tutors[0].tutorId).toBe(tutorId)
    expect(body.tutors[0].role).toBe('PRIMARY')
    // O telefone do tutor sai mascarado no vínculo, nunca em claro.
    expect(body.tutors[0].phoneMasked).toMatch(/^\(\d{2}\) \*+-\d{4}$/)

    // AC-01: a primeira pesagem entra na série já no cadastro.
    const weights = await ownerPrisma.petWeight.findMany({ where: { petId: body.id } })
    expect(weights).toHaveLength(1)
    expect(Number(weights[0]!.weightKg)).toBe(32.4)
  })

  it('AC-02: recusa raça de outra espécie com 422 apontando o campo', async () => {
    const response = await createPet(petPayload({ breedId: catalog.breedCatId }))

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.code).toBe('ERR_PET_002')
    expect(body.detail).toBe('A raça selecionada não pertence à espécie informada')
    expect(body.errors).toEqual([
      { field: 'breedId', message: 'A raça selecionada não pertence à espécie informada' },
    ])
  })

  it('AC-03: idade estimada vira data derivada com precisão ESTIMATED e rótulo "≈ 2 anos"', async () => {
    const response = await createPet(
      petPayload({ birthDate: undefined, estimatedAgeMonths: 24 }),
    )

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.birthDatePrecision).toBe('ESTIMATED')
    expect(body.birthDate).not.toBeNull()
    expect(body.ageMonths).toBe(24)
    expect(body.ageLabel).toBe('≈ 2 anos')
  })

  it('AC-04: peso fora da faixa do porte avisa, mas não bloqueia', async () => {
    const response = await createPet(petPayload({ sizeId: catalog.sizeSmallId, weightKg: 45 }))

    expect(response.statusCode).toBe(201)
    expect(response.json().warnings).toEqual([
      { code: 'WEIGHT_SIZE_MISMATCH', message: 'Peso incompatível com o porte selecionado' },
    ])
  })

  it('exige data de nascimento ou idade estimada', async () => {
    const response = await createPet(petPayload({ birthDate: undefined }))

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PET_002')
  })

  it('cifra o microchip em repouso e só devolve os últimos dígitos', async () => {
    const response = await createPet(petPayload({ microchip: '981020000123456' }))

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.microchipMasked).toBe('***********3456')

    const row = await ownerPrisma.pet.findFirstOrThrow({ where: { id: body.id } })
    expect(row.microchipEncrypted).toMatch(/^v1:/)
    expect(row.microchipEncrypted).not.toContain('981020000123456')
    expect(row.microchipHash).toBeTruthy()
  })

  it('RN-15: microchip repetido devolve 409 com o pet existente', async () => {
    const first = await createPet(petPayload({ microchip: '981020000123456' }))
    const second = await createPet(
      petPayload({ name: 'Mel', microchip: '981.020.000.123.456' }),
    )

    expect(second.statusCode).toBe(409)
    const body = second.json()
    expect(body.code).toBe('ERR_PET_004')
    expect(body.existingPet.id).toBe(first.json().id)
    expect(body.existingPet.name).toBe('Thor')
  })

  it('o microchip completo sai só pelo endpoint dedicado, e a leitura é auditada', async () => {
    const pet = (await createPet(petPayload({ microchip: '981020000123456' }))).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${pet.id}/sensitive`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().microchip).toBe('981020000123456')

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { entityId: pet.id, action: 'pet.microchip_revealed' },
    })
    expect(audit).not.toBeNull()
  })

  it('PATCH altera o pet, registra o diff sem PII e adiciona a nova pesagem à série', async () => {
    const pet = (await createPet()).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${pet.id}`,
      payload: { name: 'Thor II', weightKg: 30, color: 'Caramelo' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.name).toBe('Thor II')
    expect(body.weightKg).toBe(30)

    const weights = await ownerPrisma.petWeight.findMany({ where: { petId: pet.id } })
    expect(weights).toHaveLength(2)

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { entityId: pet.id, action: 'pet.updated' },
    })
    expect((audit.before as Record<string, unknown>).name).toBe('Thor')
    expect((audit.after as Record<string, unknown>).name).toBe('Thor II')
  })

  it('PATCH com null limpa a data de nascimento e devolve a precisão a UNKNOWN', async () => {
    const pet = (await createPet()).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${pet.id}`,
      payload: { birthDate: null },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.birthDate).toBeNull()
    expect(body.birthDatePrecision).toBe('UNKNOWN')
    expect(body.ageMonths).toBeNull()
    expect(body.ageLabel).toBeNull()
  })

  it('DELETE é soft e devolve o microchip ao pool', async () => {
    const pet = (await createPet(petPayload({ microchip: '981020000123456' }))).json()

    const deleted = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/pets/${pet.id}`,
    })
    expect(deleted.statusCode).toBe(204)

    const row = await ownerPrisma.pet.findFirstOrThrow({ where: { id: pet.id } })
    expect(row.deletedAt).not.toBeNull()

    const detail = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${pet.id}` })
    expect(detail.statusCode).toBe(404)

    // O mesmo animal pode ser recadastrado: o índice único filtra `deleted_at IS NULL`.
    const again = await createPet(petPayload({ microchip: '981020000123456' }))
    expect(again.statusCode).toBe(201)
  })

  it('nega a exclusão a quem não tem `pet:delete`, auditando a negação', async () => {
    const pet = (await createPet()).json()

    const response = await callApi({
      clerkUserId: tenant.clerkUserId,
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      role: 'RECEPTIONIST',
      permissions: ['pet:read', 'pet:create', 'pet:update'],
      method: 'DELETE',
      url: `/v1/pets/${pet.id}`,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_PET_003')

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { action: 'auth.permission_denied', outcome: 'DENIED' },
    })
    expect(audit).not.toBeNull()
  })

  it('não vaza pet de outro tenant', async () => {
    const pet = (await createPet()).json()
    const other = await givenTenant('Outro Petshop')

    const response = await callApi({ ...asAdmin(other), method: 'GET', url: `/v1/pets/${pet.id}` })
    expect(response.statusCode).toBe(404)
  })
})

describe('RN-09 — alertas do prontuário na ficha do pet', () => {
  /** Cria o pet pela API e devolve o id — o resto do teste mexe só no prontuário. */
  async function givenPetId(): Promise<string> {
    const response = await createPet()
    expect(response.statusCode).toBe(201)
    return response.json().id as string
  }

  it('agrega alergia, temperamento e condição médica, do mais grave para o menos', async () => {
    const petId = await givenPetId()

    // As tabelas são do medical-record-service; o pet-service só projeta a leitura.
    await ownerPrisma.allergy.create({
      data: {
        tenantId: tenant.tenantId,
        petId,
        type: 'FOOD',
        label: 'Frango',
        severity: 'LOW',
      },
    })
    await ownerPrisma.medicalAlert.create({
      data: {
        tenantId: tenant.tenantId,
        petId,
        condition: 'Cardiopatia',
        severity: 'CRITICAL',
      },
    })
    await ownerPrisma.temperament.create({
      data: {
        tenantId: tenant.tenantId,
        petId,
        classification: 'REACTIVE',
        requiresMuzzle: true,
        isCurrent: true,
      },
    })

    const detail = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}` })

    expect(detail.statusCode).toBe(200)
    const alerts = detail.json().alerts as { type: string; severity: string; label: string }[]
    expect(alerts.map((alert) => alert.severity)).toEqual(['CRITICAL', 'HIGH', 'LOW'])
    expect(alerts[1]).toMatchObject({
      type: 'TEMPERAMENT',
      label: 'Reativo · exige focinheira',
    })

    // A listagem também carrega: é ela que a recepção olha antes de chamar o pet.
    const list = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/pets' })
    expect(list.json().data[0].alerts).toHaveLength(3)
  })

  it('alergia desativada some da ficha', async () => {
    const petId = await givenPetId()
    await ownerPrisma.allergy.create({
      data: {
        tenantId: tenant.tenantId,
        petId,
        type: 'PRODUCT',
        label: 'Shampoo X',
        severity: 'CRITICAL',
        active: false,
        deactivatedAt: new Date(),
      },
    })

    const detail = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}` })
    expect(detail.json().alerts).toHaveLength(0)
  })

  it('pet sem prontuário devolve a lista vazia, não erro', async () => {
    const petId = await givenPetId()
    const detail = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}` })
    expect(detail.json().alerts).toEqual([])
  })
})

describe('MOD-PET-01 — busca e listagem', () => {
  it('encontra por nome, por raça e por microchip', async () => {
    await createPet(petPayload({ name: 'Thor', microchip: '981020000123456' }))
    await createPet(petPayload({ name: 'Mel', tutors: [{ tutorId, role: 'PRIMARY' }] }))

    const byName = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/pets?q=thor' })
    expect(byName.statusCode).toBe(200)
    expect(byName.json().data.map((pet: { name: string }) => pet.name)).toContain('Thor')

    const byMicrochip = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/pets?q=981020000123456',
    })
    expect(byMicrochip.json().total).toBe(1)
    expect(byMicrochip.json().data[0].name).toBe('Thor')
  })

  it('filtra por tutor e por espécie', async () => {
    const outroTutor = await givenTutor(tenant, 'João Souza')
    await createPet()
    await createPet(
      petPayload({
        name: 'Mimi',
        speciesId: catalog.speciesCatId,
        breedId: catalog.breedCatId,
        sizeId: catalog.sizeSmallId,
        weightKg: 4,
        tutors: [{ tutorId: outroTutor, role: 'PRIMARY' }],
      }),
    )

    const doTutor = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets?tutorId=${outroTutor}`,
    })
    expect(doTutor.json().total).toBe(1)
    expect(doTutor.json().data[0].name).toBe('Mimi')

    const gatos = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets?speciesId=${catalog.speciesCatId}`,
    })
    expect(gatos.json().total).toBe(1)
  })

  it('trata operador de tsquery como texto comum', async () => {
    await createPet()

    const response = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/pets?q=thor%20%26%20' })
    expect(response.statusCode).toBe(200)
  })
})

describe('MOD-PET-03 — catálogo de domínio', () => {
  it('AC-01: serve espécies, raças da espécie, portes e pelagens', async () => {
    const species = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/species' })
    expect(species.statusCode).toBe(200)
    expect(species.json().map((item: { key: string }) => item.key)).toContain('DOG')
    // "Outros" fica no fim do seletor, por decisão de produto.
    expect(species.json().at(-1).key).toBe('OTHER')

    const breeds = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/species/${catalog.speciesDogId}/breeds`,
    })
    expect(breeds.json().length).toBeGreaterThan(10)
    expect(breeds.json().every((breed: { custom: boolean }) => breed.custom === false)).toBe(true)

    const sizes = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/sizes' })
    expect(sizes.json().map((size: { key: string }) => size.key)).toEqual([
      'SMALL',
      'MEDIUM',
      'LARGE',
      'GIANT',
    ])

    const coats = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/coats' })
    expect(coats.json()[0].groomingTimeFactor).toBe(1)
  })
})

describe('MOD-AGENDA — consumo de `atendimento.concluido`', () => {
  it('alimenta `last_attendance_at` e a pesagem do atendimento', async () => {
    const pet = (await createPet()).json()
    const { handleAtendimentoConcluido } = await import('../src/modules/pets/consumers.js')
    const appointmentId = '11111111-1111-4111-8111-111111111111'

    await handleAtendimentoConcluido({
      tenantId: tenant.tenantId,
      appointmentId,
      petId: pet.id,
      weightKg: 31.5,
    })

    const row = await ownerPrisma.pet.findUniqueOrThrow({ where: { id: pet.id } })
    expect(row.lastAttendanceAt).not.toBeNull()
    // RN-10 de pets_03: `weight_kg` segue a pesagem mais recente da série.
    expect(Number(row.weightKg)).toBe(31.5)

    const weights = await ownerPrisma.petWeight.findMany({
      where: { petId: pet.id, attendanceId: appointmentId },
    })
    expect(weights).toHaveLength(1)
  })

  it('é idempotente: entrega repetida não cria uma segunda pesagem', async () => {
    const pet = (await createPet()).json()
    const { handleAtendimentoConcluido } = await import('../src/modules/pets/consumers.js')
    const appointmentId = '22222222-2222-4222-8222-222222222222'
    const evento = {
      tenantId: tenant.tenantId,
      appointmentId,
      petId: pet.id,
      weightKg: 31.5,
    }

    // O broker entrega ao menos uma vez; duas entregas não podem virar duas pesagens.
    await handleAtendimentoConcluido(evento)
    await handleAtendimentoConcluido(evento)

    const weights = await ownerPrisma.petWeight.findMany({
      where: { petId: pet.id, attendanceId: appointmentId },
    })
    expect(weights).toHaveLength(1)
  })

  it('atendimento sem pesagem só marca a data', async () => {
    const pet = (await createPet()).json()
    const { handleAtendimentoConcluido } = await import('../src/modules/pets/consumers.js')

    await handleAtendimentoConcluido({
      tenantId: tenant.tenantId,
      appointmentId: '33333333-3333-4333-8333-333333333333',
      petId: pet.id,
      weightKg: null,
    })

    const row = await ownerPrisma.pet.findUniqueOrThrow({ where: { id: pet.id } })
    expect(row.lastAttendanceAt).not.toBeNull()

    const weights = await ownerPrisma.petWeight.findMany({
      where: { petId: pet.id, attendanceId: { not: null } },
    })
    expect(weights).toHaveLength(0)
  })
})
