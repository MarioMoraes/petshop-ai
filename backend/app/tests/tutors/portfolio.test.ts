import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { portfolioQuality } from '../../src/modules/tutors/portfolio.js'
import {
  asAdmin,
  asRole,
  callApi,
  closeHarness,
  givenTenant,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * Qualidade da carteira — cadastros completos e opt-in de WhatsApp no Início.
 *
 * O que vale provar não é a contagem, é a regra do consentimento que ela carrega: a
 * **última** transição do canal decide, `TRANSACTIONAL` sozinho não é opt-in de
 * campanha, e tutor inativo sai do numerador e do denominador ao mesmo tempo.
 */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

async function cadastrar(fullName: string, phone: string, whatsapp: boolean): Promise<string> {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/tutors',
    payload: { fullName, phone, consents: { whatsapp, email: false, terms: true } },
  })
  expect(response.statusCode).toBe(201)
  return response.json().id
}

async function transicionar(tutorId: string, transitions: unknown[]): Promise<void> {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'PUT',
    url: `/v1/tutors/${tutorId}/consents`,
    payload: { transitions },
  })
  expect(response.statusCode).toBeLessThan(300)
}

async function marcar(
  tutorId: string,
  data: { status?: 'ACTIVE' | 'INACTIVE'; dataCompleteness?: 'COMPLETE' | 'PARTIAL' },
): Promise<void> {
  await withTenant(tenant.tenantId, (tx) => tx.tutor.update({ where: { id: tutorId }, data }))
}

describe('qualidade da carteira', () => {
  it('conta o opt-in pela última transição de marketing, só entre tutores ativos', async () => {
    const aceita = await cadastrar('Ana Aceita', '11987650001', true)
    const revogou = await cadastrar('Bruno Revogou', '11987650002', true)
    const soTransacional = await cadastrar('Carla Transacional', '11987650003', false)
    const inativo = await cadastrar('Davi Inativo', '11987650004', true)

    await transicionar(revogou, [{ channel: 'WHATSAPP', granted: false }])
    await transicionar(soTransacional, [
      { channel: 'WHATSAPP', granted: true, purpose: 'TRANSACTIONAL' },
    ])

    await marcar(aceita, { dataCompleteness: 'COMPLETE' })
    await marcar(revogou, { dataCompleteness: 'PARTIAL' })
    await marcar(soTransacional, { dataCompleteness: 'PARTIAL' })
    await marcar(inativo, { status: 'INACTIVE', dataCompleteness: 'COMPLETE' })

    expect(await portfolioQuality(tenant.tenantId)).toEqual({
      active: 3,
      complete: 1,
      whatsappMarketing: 1,
    })
  })

  it('reautorizar depois de revogar volta a contar', async () => {
    const tutorId = await cadastrar('Elisa Voltou', '11987650005', true)
    await transicionar(tutorId, [{ channel: 'WHATSAPP', granted: false }])
    await transicionar(tutorId, [{ channel: 'WHATSAPP', granted: true }])

    const result = await portfolioQuality(tenant.tenantId)
    expect(result.whatsappMarketing).toBe(1)
  })

  it('responde pela rota a quem vê tutores, e recusa quem não vê', async () => {
    await cadastrar('Fábio Rota', '11987650006', true)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors/reports/portfolio',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ active: 1, whatsappMarketing: 1 })

    // O motorista só lê o tutor da corrida dele (`tutor:read_assigned`).
    const motorista = await asRole(tenant, 'DRIVER')
    const negado = await callApi({
      ...motorista,
      method: 'GET',
      url: '/v1/tutors/reports/portfolio',
    })
    expect(negado.statusCode).toBe(403)
  })
})
