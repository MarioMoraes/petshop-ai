import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  catalogIds,
  closeHarness,
  givenTenant,
  givenTutor,
  resetDatabase,
  type CatalogFixture,
  type TenantFixture,
} from './fixtures.js'

/** O cartão de aniversariantes do Início (Aurora, 2026-11-04). */

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

async function pet(name: string, extra: Record<string, unknown>) {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/pets',
    payload: {
      name,
      speciesId: catalog.speciesDogId,
      sizeId: catalog.sizeLargeId,
      sex: 'MALE',
      tutors: [{ tutorId, role: 'PRIMARY' }],
      ...extra,
    },
  })
  expect(response.statusCode).toBe(201)
}

function birthdays(from: string, days = 7) {
  return callApi({
    ...asAdmin(tenant),
    method: 'GET',
    url: `/v1/pets/birthdays?from=${from}&days=${days}`,
  })
}

describe('GET /v1/pets/birthdays', () => {
  it('lista quem faz anos na janela, em ordem, com a idade que completa', async () => {
    await pet('Paçoca', { birthDate: '2022-11-04' })
    await pet('Luna', { birthDate: '2024-11-07' })
    await pet('Fora', { birthDate: '2020-11-20' })
    await pet('Estimado', { estimatedAgeMonths: 24 })

    const response = await birthdays('2026-11-04')
    expect(response.statusCode).toBe(200)
    expect(
      response
        .json()
        .items.map((i: { name: string; date: string; turning: number }) => [
          i.name,
          i.date,
          i.turning,
        ]),
    ).toEqual([
      ['Paçoca', '2026-11-04', 4],
      ['Luna', '2026-11-07', 2],
    ])
  })

  it('o 29 de fevereiro faz anos no dia 28 em ano comum', async () => {
    await pet('Bissexto', { birthDate: '2020-02-29' })
    const items = (await birthdays('2027-02-28', 1)).json().items
    expect(items).toHaveLength(1)
    expect(items[0].date).toBe('2027-02-28')
  })

  it('valida a query', async () => {
    expect((await birthdays('ontem')).statusCode).toBe(422)
  })
})
