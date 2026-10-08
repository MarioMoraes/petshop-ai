import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  callApi,
  closeHarness,
  givenPet,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * A carteira de vacinação no Portal (MOD-PRONT-08, RN-09).
 *
 * O recorte é o que se prova: o pet de outro tutor não abre, e a dose anulada não chega
 * ao celular de quem é dono do pet.
 */

let fixture: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
})

afterAll(async () => {
  await closeHarness()
})

async function givenDose(
  petId: string,
  dose: { vaccineLabel: string; appliedAt: string; nextDoseAt: string; voided?: boolean },
): Promise<void> {
  await withTenant(fixture.tenantId, (tx) =>
    tx.vaccination.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        origin: 'EXTERNAL',
        vaccineKey: 'OTHER',
        vaccineLabel: dose.vaccineLabel,
        appliedAt: new Date(dose.appliedAt),
        nextDoseAt: new Date(dose.nextDoseAt),
        externalClinic: 'Clínica do Bairro',
        ...(dose.voided ? { voidedAt: new Date(), voidReason: 'Lançada no pet errado' } : {}),
      },
    }),
  )
}

function carteira(tutorId: string, petId: string) {
  return callApi({
    method: 'GET',
    url: `/portal/v1/pets/${petId}/vaccinations`,
    ...asTutor(fixture, tutorId),
  })
}

describe('GET /portal/v1/pets/:petId/vaccinations', () => {
  it('mostra a carteira do próprio pet, sem a dose anulada', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    await givenDose(petId, { vaccineLabel: 'Coronavírus', appliedAt: '2026-01-10', nextDoseAt: '2099-01-10' })
    await givenDose(petId, {
      vaccineLabel: 'Leptospirose',
      appliedAt: '2026-01-11',
      nextDoseAt: '2027-01-11',
      voided: true,
    })

    const response = await carteira(tutorId, petId)

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('UP_TO_DATE')
    expect(body.history).toHaveLength(1)
    expect(body.current[0]).toMatchObject({
      vaccineLabel: 'Coronavírus',
      externalClinic: 'Clínica do Bairro',
      voidReason: null,
    })
  })

  it('a carteira vencida aparece como atrasada', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    await givenDose(petId, { vaccineLabel: 'Coronavírus', appliedAt: '2024-01-10', nextDoseAt: '2025-01-10' })

    expect((await carteira(tutorId, petId)).json().status).toBe('OVERDUE')
  })

  it('o pet de outro tutor é 404', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs, { name: 'Rex' })
    await givenDose(petId, { vaccineLabel: 'Coronavírus', appliedAt: '2026-01-10', nextDoseAt: '2027-01-10' })

    expect((await carteira(mine, petId)).statusCode).toBe(404)
  })
})
