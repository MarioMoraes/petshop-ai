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
} from './fixtures.js'

/**
 * MOD-PET-02 — vínculo N:N pet ↔ tutor, pelos critérios de aceite do PRD pets_03 §3,
 * mais os dois consumidores de evento do §8 que mexem no vínculo.
 */

let tenant: TenantFixture
let catalog: CatalogFixture
let primaryTutorId: string
let secondTutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  catalog = await catalogIds()
  primaryTutorId = await givenTutor(tenant, 'Maria Silva')
  secondTutorId = await givenTutor(tenant, 'João Silva')
})

afterAll(closeHarness)

async function givenPet(): Promise<string> {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/pets',
    payload: {
      name: 'Thor',
      speciesId: catalog.speciesDogId,
      sizeId: catalog.sizeLargeId,
      sex: 'MALE',
      birthDate: '2021-03-10',
      tutors: [{ tutorId: primaryTutorId, role: 'PRIMARY' }],
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json().id as string
}

describe('MOD-PET-02 — vínculo pet ↔ tutor', () => {
  it('AC-01: o segundo tutor do casal é vinculado e passa a ver o pet', async () => {
    const petId = await givenPet()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/tutors`,
      payload: { tutorId: secondTutorId, role: 'SECONDARY', relationship: 'Cônjuge' },
    })

    expect(response.statusCode).toBe(201)
    const link = response.json()
    expect(link.role).toBe('SECONDARY')
    expect(link.relationship).toBe('Cônjuge')
    expect(link.canAuthorizeProcedures).toBe(true)

    // Ambos passam a enxergar o pet na listagem por tutor.
    for (const tutorId of [primaryTutorId, secondTutorId]) {
      const list = await callApi({
        ...asAdmin(tenant),
        method: 'GET',
        url: `/v1/pets?tutorId=${tutorId}`,
      })
      expect(list.json().total).toBe(1)
    }

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { entityId: petId, action: 'pet.tutor_linked' },
    })
    expect(audit).not.toBeNull()
  })

  it('AC-02: segundo PRIMARY devolve 409 com o principal atual', async () => {
    const petId = await givenPet()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/tutors`,
      payload: { tutorId: secondTutorId, role: 'PRIMARY' },
    })

    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.code).toBe('ERR_PET_004')
    expect(body.detail).toBe(
      'Este pet já possui um responsável principal. Altere o atual antes de definir outro.',
    )
    expect(body.currentPrimary.tutorId).toBe(primaryTutorId)
  })

  it('AC-03: remover o último responsável devolve 409 apontando a transferência', async () => {
    const petId = await givenPet()
    const links = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/tutors` })
    ).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/pets/${petId}/tutors/${links[0].linkId}`,
    })

    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.code).toBe('ERR_PET_005')
    expect(body.detail).toBe(
      'O pet precisa de ao menos um responsável. Use a transferência de titularidade.',
    )
    expect(body.transferPath).toBe(`/v1/pets/${petId}/transfer`)
  })

  it('desvincula o secundário e mantém a linha como histórico', async () => {
    const petId = await givenPet()
    const link = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: `/v1/pets/${petId}/tutors`,
        payload: { tutorId: secondTutorId, role: 'SECONDARY' },
      })
    ).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/pets/${petId}/tutors/${link.linkId}`,
    })
    expect(response.statusCode).toBe(204)

    const row = await ownerPrisma.petTutor.findFirstOrThrow({ where: { id: link.linkId } })
    expect(row.unlinkedAt).not.toBeNull()

    const remaining = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/tutors` })
    ).json()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].tutorId).toBe(primaryTutorId)
  })

  it('troca o responsável principal em dois passos, auditando a mudança', async () => {
    const petId = await givenPet()
    const secondary = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: `/v1/pets/${petId}/tutors`,
        payload: { tutorId: secondTutorId, role: 'SECONDARY' },
      })
    ).json()
    const links = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/tutors` })
    ).json()
    const currentPrimary = links.find((link: { role: string }) => link.role === 'PRIMARY')

    // Promover direto não passa: o principal atual precisa ser rebaixado antes.
    const direct = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/tutors/${secondary.linkId}`,
      payload: { role: 'PRIMARY' },
    })
    expect(direct.statusCode).toBe(409)

    const demote = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/tutors/${currentPrimary.linkId}`,
      payload: { role: 'SECONDARY' },
    })
    expect(demote.statusCode).toBe(200)

    const promote = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/tutors/${secondary.linkId}`,
      payload: { role: 'PRIMARY' },
    })
    expect(promote.statusCode).toBe(200)
    expect(promote.json().role).toBe('PRIMARY')

    const audit = await ownerPrisma.auditLog.findMany({
      where: { entityId: petId, action: 'pet.primary_tutor_changed' },
    })
    expect(audit).toHaveLength(2)
  })

  it('recusa vincular o mesmo tutor duas vezes', async () => {
    const petId = await givenPet()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/tutors`,
      payload: { tutorId: primaryTutorId, role: 'SECONDARY' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().detail).toBe('Este tutor já está vinculado ao pet')
  })

  it('recusa o cadastro com tutor de outro tenant', async () => {
    const other = await givenTenant('Outro Petshop')
    const foreignTutor = await givenTutor(other, 'Alheio')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/pets',
      payload: {
        name: 'Thor',
        speciesId: catalog.speciesDogId,
        sizeId: catalog.sizeLargeId,
        birthDate: '2021-03-10',
        tutors: [{ tutorId: foreignTutor, role: 'PRIMARY' }],
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().errors).toEqual([{ field: 'tutorId', message: 'Tutor não encontrado' }])
  })

  it('exige exatamente um responsável principal no cadastro', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/pets',
      payload: {
        name: 'Thor',
        speciesId: catalog.speciesDogId,
        sizeId: catalog.sizeLargeId,
        birthDate: '2021-03-10',
        tutors: [
          { tutorId: primaryTutorId, role: 'PRIMARY' },
          { tutorId: secondTutorId, role: 'PRIMARY' },
        ],
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PET_002')
  })
})

describe('MOD-PET-02 — consumidores de evento do ciclo de vida do tutor', () => {
  it('tutor anonimizado sai dos vínculos e o secundário assume o lugar', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/tutors`,
      payload: { tutorId: secondTutorId, role: 'SECONDARY' },
    })

    const { handleTutorAnonimizado } = await import('../../src/modules/pets/consumers.js')
    const affected = await handleTutorAnonimizado({
      tenantId: tenant.tenantId,
      tutorId: primaryTutorId,
    })
    expect(affected).toEqual([petId])

    const links = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/tutors` })
    ).json()
    expect(links).toHaveLength(1)
    expect(links[0].tutorId).toBe(secondTutorId)
    // O pet nunca fica sem quem responda por ele enquanto sobrar alguém (RN-04).
    expect(links[0].role).toBe('PRIMARY')

    // O prontuário do animal sobrevive à anonimização da pessoa (RN-06).
    const pet = await ownerPrisma.pet.findFirstOrThrow({ where: { id: petId } })
    expect(pet.deletedAt).toBeNull()
  })

  it('tutores mesclados deixam um único vínculo vivo por pet', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/tutors`,
      payload: { tutorId: secondTutorId, role: 'SECONDARY' },
    })

    const { handleTutorMesclado } = await import('../../src/modules/pets/consumers.js')
    await handleTutorMesclado({
      tenantId: tenant.tenantId,
      sourceId: secondTutorId,
      targetId: primaryTutorId,
    })

    const links = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/tutors` })
    ).json()
    expect(links).toHaveLength(1)
    expect(links[0].tutorId).toBe(primaryTutorId)
    expect(links[0].role).toBe('PRIMARY')
  })

  it('a mescla move o vínculo quando o destino ainda não conhecia o pet', async () => {
    const petId = await givenPet()

    const { handleTutorMesclado } = await import('../../src/modules/pets/consumers.js')
    await handleTutorMesclado({
      tenantId: tenant.tenantId,
      sourceId: primaryTutorId,
      targetId: secondTutorId,
    })

    const links = (
      await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/tutors` })
    ).json()
    expect(links).toHaveLength(1)
    expect(links[0].tutorId).toBe(secondTutorId)
    expect(links[0].role).toBe('PRIMARY')
  })
})
