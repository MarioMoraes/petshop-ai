import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { criticalPets } from '../../src/modules/records/critical-pets.js'
import {
  asAdmin,
  asRoleIn,
  callApi,
  closeHarness,
  givenPet,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * Pets com alerta crítico no Início.
 *
 * O eixo é a regra do que é crítico ser a mesma da ficha: alergia e condição médica pela
 * severidade gravada, temperamento pelo mapa de `alerts.ts` — agressivo é crítico,
 * reativo não. E só o que está **ativo** e **vigente** conta, em pet que ainda frequenta.
 */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function alergia(petId: string, active = true) {
  return ownerPrisma.allergy.create({
    data: {
      tenantId: tenant.tenantId,
      petId,
      type: 'FOOD',
      label: 'Frango',
      severity: 'CRITICAL',
      active,
    },
  })
}

function temperamento(
  petId: string,
  classification: 'AGGRESSIVE' | 'REACTIVE' | 'DOCILE',
  isCurrent = true,
) {
  return ownerPrisma.temperament.create({
    data: {
      tenantId: tenant.tenantId,
      petId,
      classification,
      contexts: [],
      notesEncrypted: 'v1:x:x:x',
      isCurrent,
    },
  })
}

describe('pets com alerta crítico', () => {
  it('conta pela regra da ficha, sem somar o pet duas vezes', async () => {
    // Alergia crítica ativa.
    const comAlergia = await givenPet(tenant, 'Thor')
    await alergia(comAlergia)

    // Agressivo e com condição crítica: um pet, duas origens.
    const agressivo = await givenPet(tenant, 'Rex')
    await temperamento(agressivo, 'AGGRESSIVE')
    await ownerPrisma.medicalAlert.create({
      data: {
        tenantId: tenant.tenantId,
        petId: agressivo,
        condition: 'Cardiopatia',
        severity: 'CRITICAL',
      },
    })

    // Alergia desativada e temperamento só reativo: nenhum dos dois é crítico hoje.
    const semCritico = await givenPet(tenant, 'Mel')
    await alergia(semCritico, false)
    await temperamento(semCritico, 'REACTIVE')

    // Foi agressivo, hoje é dócil: o histórico não é o alerta vigente.
    const melhorou = await givenPet(tenant, 'Bidu')
    await temperamento(melhorou, 'AGGRESSIVE', false)
    await temperamento(melhorou, 'DOCILE')

    // Falecido não entra mais no salão.
    const falecido = await givenPet(tenant, 'Pipoca')
    await alergia(falecido)
    await ownerPrisma.pet.update({
      where: { id: falecido },
      data: { status: 'DECEASED', deceasedAt: new Date(), deceasedRecordedAt: new Date() },
    })

    expect(await criticalPets(tenant.tenantId)).toEqual({
      pets: 2,
      byAllergy: 1,
      byTemperament: 1,
      byMedical: 1,
    })
  })

  it('responde pela rota a quem lê o resumo, e recusa o banhista', async () => {
    const petId = await givenPet(tenant)
    await alergia(petId)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/records/reports/critical-pets',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ pets: 1, byAllergy: 1 })

    const recepcao = await asRoleIn(tenant, 'RECEPTIONIST')
    const permitido = await callApi({
      ...recepcao,
      method: 'GET',
      url: '/v1/records/reports/critical-pets',
    })
    expect(permitido.statusCode).toBe(200)

    // O banhista vê o alerta do pet que atende, não a contagem da casa.
    const banhista = await asRoleIn(tenant, 'BATHER')
    const negado = await callApi({
      ...banhista,
      method: 'GET',
      url: '/v1/records/reports/critical-pets',
    })
    expect(negado.statusCode).toBe(403)
  })
})
