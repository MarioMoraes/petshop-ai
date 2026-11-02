import { withTenant } from '@petshop/db'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCipher } from '../../src/modules/records/crypto.js'
import { setPdfPort } from '../../src/modules/records/pdf-port.js'
import {
  asAdmin,
  asRoleIn,
  callApi,
  closeHarness,
  givenPet,
  givenTenant,
  givenTutor,
  linkTutor,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-PET-11 — a ficha do pet para a sala de banho e tosa.
 *
 * O que se prova: a folha traz o que pode machucar, quem a imprime é quem manuseia o pet,
 * e o telefone do tutor só aparece para quem lê tutor.
 */

let tenant: TenantFixture
let rendered: string[]

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  rendered = []
  setPdfPort({
    async render(html) {
      rendered.push(html)
      return Buffer.from('%PDF-1.4 dublê')
    },
  })
})

afterEach(() => setPdfPort(null))
afterAll(closeHarness)

async function petComRisco(): Promise<string> {
  const petId = await givenPet(tenant, 'Thor <b>')
  const tutorId = await givenTutor(tenant, 'Ana Souza')
  await withTenant(tenant.tenantId, async (tx) => {
    const cipher = await openCipher(tx, tenant.tenantId)
    await tx.tutor.update({
      where: { id: tutorId },
      data: { phoneEncrypted: cipher.encrypt('+5511987654321') },
    })
  })
  await linkTutor(tenant, petId, tutorId)

  const admin = asAdmin(tenant)
  await callApi({
    ...admin,
    method: 'POST',
    url: `/v1/pets/${petId}/allergies`,
    payload: {
      type: 'PRODUCT',
      label: 'Clorexidina',
      severity: 'HIGH',
      reaction: 'Coceira intensa',
      blocksProducts: ['shampoo antisséptico'],
    },
  })
  await callApi({
    ...admin,
    method: 'POST',
    url: `/v1/pets/${petId}/temperament`,
    payload: {
      classification: 'AGGRESSIVE',
      contexts: ['DRYER'],
      notes: 'Morde quando o secador chega perto do rosto',
      requiresMuzzle: true,
    },
  })
  return petId
}

describe('a ficha do pet', () => {
  it('o banhista imprime: alergia, temperamento, cuidados e o contato do tutor', async () => {
    const petId = await petComRisco()
    const banhista = await asRoleIn(tenant, 'BATHER')

    const response = await callApi({
      ...banhista,
      method: 'GET',
      url: `/v1/pets/${petId}/sheet/pdf`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    const html = rendered[0] ?? ''
    expect(html).toContain('Thor &lt;b&gt;')
    expect(html).toContain('Atenção antes de manusear')
    expect(html).toContain('Clorexidina')
    expect(html).toContain('Não usar: shampoo antisséptico')
    expect(html).toContain('Agressivo')
    expect(html).toContain('Usar focinheira')
    expect(html).toContain('Reage a: Secador')
    expect(html).toContain('Ana Souza')
    expect(html).toContain('(11) 98765-4321')
  })

  it('o motorista imprime os alertas, mas sem o tutor — ele não lê a ficha de tutores', async () => {
    const petId = await petComRisco()
    const motorista = await asRoleIn(tenant, 'DRIVER')

    const response = await callApi({
      ...motorista,
      method: 'GET',
      url: `/v1/pets/${petId}/sheet/pdf`,
    })

    expect(response.statusCode).toBe(200)
    const html = rendered[0] ?? ''
    expect(html).toContain('Clorexidina')
    expect(html).not.toContain('Ana Souza')
    expect(html).not.toContain('98765-4321')
  })

  it('pet sem nada de risco diz isso, em vez de uma caixa vermelha vazia', async () => {
    const petId = await givenPet(tenant, 'Mel')

    await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/sheet/pdf` })

    const html = rendered[0] ?? ''
    expect(html).toContain('Nenhuma alergia, alerta ou temperamento de risco registrado.')
    expect(html).not.toContain('Atenção antes de manusear')
  })

  it('sem `record:read_alerts` não imprime', async () => {
    const petId = await givenPet(tenant)
    const recepcao = await asRoleIn(tenant, 'RECEPTIONIST')
    const { revokePermission } = await import('../harness.js')
    await revokePermission(tenant, 'RECEPTIONIST', 'record:read_alerts')

    const response = await callApi({
      ...recepcao,
      method: 'GET',
      url: `/v1/pets/${petId}/sheet/pdf`,
    })

    expect(response.statusCode).toBe(403)
  })

  it('pet de outro estabelecimento é 404', async () => {
    const outro = await givenTenant('Outro Petshop')
    const petId = await givenPet(outro)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${petId}/sheet/pdf`,
    })

    expect(response.statusCode).toBe(404)
  })
})
