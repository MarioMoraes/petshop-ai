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
 * MOD-PET-03 — tabelas de domínio, pelos quatro critérios de aceite do PRD
 * pets_03 §3.
 *
 * O eixo é RN-02: o catálogo global é da plataforma e o tenant só acrescenta o dele.
 * Os testes de 403 e de DELETE existem para provar que a regra vale no banco, não
 * apenas no `if` do serviço.
 */

let tenant: TenantFixture
let other: TenantFixture
let catalog: CatalogFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  other = await givenTenant('Outro Petshop')
  catalog = await catalogIds()
})

afterAll(closeHarness)

async function createBreed(payload: Record<string, unknown>, fixture = tenant) {
  return callApi({ ...asAdmin(fixture), method: 'POST', url: '/v1/breeds', payload })
}

describe('MOD-PET-03 — catálogo de domínio', () => {
  it('AC-01: o seletor traz as raças globais da espécie somadas às do tenant', async () => {
    const created = await createBreed({ speciesId: catalog.speciesDogId, label: 'Vira-lata Caramelo' })
    expect(created.statusCode).toBe(201)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/species/${catalog.speciesDogId}/breeds`,
    })

    expect(response.statusCode).toBe(200)
    const breeds = response.json() as { id: string; label: string; custom: boolean }[]
    expect(breeds.some((breed) => breed.custom)).toBe(true)
    expect(breeds.some((breed) => !breed.custom)).toBe(true)
    // Ordem alfabética é requisito do AC-01, e em pt-BR: "São Bernardo" vem entre
    // "Samoieda" e "Schnauzer", não depois de "Staffordshire" como o collation do
    // Postgres devolveria.
    const labels = breeds.map((breed) => breed.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'pt-BR')))
  })

  it('AC-01: a raça de um tenant não vaza para o seletor do outro', async () => {
    await createBreed({ speciesId: catalog.speciesDogId, label: 'Raça Exclusiva' })

    const response = await callApi({
      ...asAdmin(other),
      method: 'GET',
      url: `/v1/species/${catalog.speciesDogId}/breeds`,
    })

    const labels = (response.json() as { label: string }[]).map((breed) => breed.label)
    expect(labels).not.toContain('Raça Exclusiva')
  })

  it('AC-02: editar raça global devolve 403 sugerindo ocultá-la', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/breeds/${catalog.breedDogId}`,
      payload: { label: 'Nome Novo' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_PET_003')

    const untouched = await ownerPrisma.breed.findUniqueOrThrow({ where: { id: catalog.breedDogId } })
    expect(untouched.label).not.toBe('Nome Novo')
  })

  it('AC-02: excluir raça global devolve 403 e a linha continua lá', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/breeds/${catalog.breedDogId}`,
    })

    expect(response.statusCode).toBe(403)
    expect(await ownerPrisma.breed.count({ where: { id: catalog.breedDogId } })).toBe(1)
  })

  it('AC-02: ocultar a raça global tira do seletor deste tenant e só dele', async () => {
    const hide = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/breeds/${catalog.breedDogId}/visibility`,
      payload: { hidden: true },
    })
    expect(hide.statusCode).toBe(200)
    expect(hide.json().hidden).toBe(true)

    const mine = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/species/${catalog.speciesDogId}/breeds`,
    })
    expect((mine.json() as { id: string }[]).map((breed) => breed.id)).not.toContain(catalog.breedDogId)

    const theirs = await callApi({
      ...asAdmin(other),
      method: 'GET',
      url: `/v1/species/${catalog.speciesDogId}/breeds`,
    })
    expect((theirs.json() as { id: string }[]).map((breed) => breed.id)).toContain(catalog.breedDogId)

    // Mostrar de volta é apagar a linha de preferência, não escrever outra.
    const show = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/breeds/${catalog.breedDogId}/visibility`,
      payload: { hidden: false },
    })
    expect(show.json().hidden).toBe(false)
    expect(await ownerPrisma.breedVisibility.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  })

  it('AC-03: raça duplicada devolve 409 com a equivalente do catálogo global', async () => {
    const global = await ownerPrisma.breed.findUniqueOrThrow({ where: { id: catalog.breedDogId } })

    // Mesma raça, escrita com acento e caixa diferentes.
    const response = await createBreed({
      speciesId: catalog.speciesDogId,
      label: global.label.toLowerCase(),
    })

    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.code).toBe('ERR_PET_004')
    expect(body.existingBreed.id).toBe(catalog.breedDogId)
  })

  it('AC-03: a mesma raça em espécies diferentes é permitida', async () => {
    const dog = await createBreed({ speciesId: catalog.speciesDogId, label: 'Pelo Curto' })
    const cat = await createBreed({ speciesId: catalog.speciesCatId, label: 'Pelo Curto' })

    expect(dog.statusCode).toBe(201)
    expect(cat.statusCode).toBe(201)
  })

  it('AC-04: raça em uso não é excluída, mas pode ser desativada', async () => {
    const breed = await createBreed({ speciesId: catalog.speciesDogId, label: 'Raça do Tenant' })
    const breedId = breed.json().id as string
    const tutorId = await givenTutor(tenant)

    const pet = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/pets',
      payload: {
        name: 'Thor',
        speciesId: catalog.speciesDogId,
        breedId,
        sizeId: catalog.sizeLargeId,
        birthDate: '2021-03-10',
        tutors: [{ tutorId, role: 'PRIMARY' }],
      },
    })
    expect(pet.statusCode).toBe(201)

    const blocked = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/breeds/${breedId}`,
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().code).toBe('ERR_PET_006')
    expect(blocked.json().petsCount).toBe(1)

    const deactivated = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/breeds/${breedId}/visibility`,
      payload: { hidden: true },
    })
    expect(deactivated.statusCode).toBe(200)

    // Some do seletor…
    const selector = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/species/${catalog.speciesDogId}/breeds`,
    })
    expect((selector.json() as { id: string }[]).map((row) => row.id)).not.toContain(breedId)

    // …e continua no pet que já a usa.
    const detail = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${pet.json().id}`,
    })
    expect(detail.json().breed.id).toBe(breedId)
  })

  it('AC-04: raça sem uso é excluída de verdade', async () => {
    const breed = await createBreed({ speciesId: catalog.speciesDogId, label: 'Raça Sem Uso' })
    const breedId = breed.json().id as string

    const response = await callApi({ ...asAdmin(tenant), method: 'DELETE', url: `/v1/breeds/${breedId}` })

    expect(response.statusCode).toBe(204)
    expect(await ownerPrisma.breed.count({ where: { id: breedId } })).toBe(0)
  })

  it('não deixa cadastrar pet com raça desativada, mas deixa editar o pet que já a usa', async () => {
    const breed = await createBreed({ speciesId: catalog.speciesDogId, label: 'Raça Desativada' })
    const breedId = breed.json().id as string
    const tutorId = await givenTutor(tenant)

    const pet = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/pets',
      payload: {
        name: 'Thor',
        speciesId: catalog.speciesDogId,
        breedId,
        sizeId: catalog.sizeLargeId,
        birthDate: '2021-03-10',
        tutors: [{ tutorId, role: 'PRIMARY' }],
      },
    })

    await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/breeds/${breedId}/visibility`,
      payload: { hidden: true },
    })

    const novoPet = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/pets',
      payload: {
        name: 'Mel',
        speciesId: catalog.speciesDogId,
        breedId,
        sizeId: catalog.sizeSmallId,
        birthDate: '2022-01-10',
        tutors: [{ tutorId, role: 'PRIMARY' }],
      },
    })
    expect(novoPet.statusCode).toBe(422)

    // Corrigir o nome do pet existente não pode esbarrar na raça desativada.
    const rename = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${pet.json().id}`,
      payload: { name: 'Thor Silva' },
    })
    expect(rename.statusCode).toBe(200)
  })

  it('a tela de catálogo enxerga o que está oculto e quantos pets usam cada raça', async () => {
    const breed = await createBreed({ speciesId: catalog.speciesDogId, label: 'Raça Gerenciada' })
    const breedId = breed.json().id as string

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/breeds?speciesId=${catalog.speciesDogId}`,
    })

    expect(response.statusCode).toBe(200)
    const rows = response.json() as { id: string; hidden: boolean; petsCount: number }[]
    const mine = rows.find((row) => row.id === breedId)
    expect(mine).toMatchObject({ hidden: false, petsCount: 0 })
    expect(rows.some((row) => row.id === catalog.breedDogId)).toBe(true)
  })

  it('só o perfil com pet:manage_catalog escreve no catálogo', async () => {
    const response = await callApi({
      clerkUserId: tenant.clerkUserId,
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      role: 'RECEPTIONIST',
      permissions: ['pet:read', 'pet:create', 'pet:update'],
      method: 'POST',
      url: '/v1/breeds',
      payload: { speciesId: catalog.speciesDogId, label: 'Raça da Recepção' },
    })

    expect(response.statusCode).toBe(403)
  })
})
