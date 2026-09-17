import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runExpireTrialsOnce } from '../../src/modules/identity/tenants/expire-trials.js'
import {
  callApi,
  closeHarness,
  ownerPrisma,
  resetDatabase,
  seedMember,
  seedTenant,
  type Caller,
  type SeededTenant,
} from '../harness.js'

/**
 * Camada comercial, fatia 3 — o fim do período de teste.
 *
 * Decisão do produto (2026-09-17): vencido o teste sem assinatura, o estabelecimento fica
 * só em leitura. Nada se apaga, a consulta continua, e a única escrita que passa é a de
 * assinar.
 */

const HORA = 60 * 60 * 1000
const SERVICO = { name: 'Banho', category: 'BATH', durationMin: 60, priceCents: 5000 }

let tenant: SeededTenant
let admin: Caller

beforeEach(async () => {
  await resetDatabase()
  tenant = await seedTenant('petshop-teste', 'TRIAL')
  const membro = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
  admin = { clerkUserId: membro.clerkUserId, clerkOrgId: tenant.clerkOrgId }
})

afterAll(closeHarness)

async function testeTerminaEm(offsetMs: number) {
  await ownerPrisma.tenant.update({
    where: { id: tenant.tenantId },
    data: { trialEndsAt: new Date(Date.now() + offsetMs) },
  })
}

describe('a varredura do teste vencido', () => {
  it('encerra o teste vencido e deixa o que ainda corre', async () => {
    await testeTerminaEm(-HORA)
    const outro = await seedTenant('petshop-no-prazo', 'TRIAL')
    await ownerPrisma.tenant.update({
      where: { id: outro.tenantId },
      data: { trialEndsAt: new Date(Date.now() + 3 * 24 * HORA) },
    })

    expect(await runExpireTrialsOnce()).toBe(1)

    const vencido = await ownerPrisma.tenant.findUnique({ where: { id: tenant.tenantId } })
    const noPrazo = await ownerPrisma.tenant.findUnique({ where: { id: outro.tenantId } })
    expect(vencido?.status).toBe('TRIAL_EXPIRED')
    expect(noPrazo?.status).toBe('TRIAL')

    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: tenant.tenantId, action: 'tenant.status_changed' },
    })
    expect(trilha?.before).toEqual({ status: 'TRIAL' })
    expect(trilha?.after).toMatchObject({ status: 'TRIAL_EXPIRED', reason: 'TRIAL_EXPIRED' })
  })

  it('rodar de novo não refaz nada', async () => {
    await testeTerminaEm(-HORA)
    expect(await runExpireTrialsOnce()).toBe(1)
    expect(await runExpireTrialsOnce()).toBe(0)
  })

  it('não toca em quem já assinou, mesmo com a data de teste no passado', async () => {
    // `trial_ends_at` fica no cadastro como registro do que foi o período.
    await testeTerminaEm(-HORA)
    await ownerPrisma.tenant.update({ where: { id: tenant.tenantId }, data: { status: 'ACTIVE' } })

    expect(await runExpireTrialsOnce()).toBe(0)
  })
})

describe('o estabelecimento com teste vencido', () => {
  beforeEach(async () => {
    await testeTerminaEm(-HORA)
    await runExpireTrialsOnce()
  })

  it('não grava, e diz por quê', async () => {
    const response = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/services',
      payload: SERVICO,
    })

    expect(response.statusCode).toBe(423)
    expect(response.json()).toMatchObject({ code: 'ERR_IDENT_008', tenantStatus: 'TRIAL_EXPIRED' })
    expect(response.json().detail).toContain('período de teste terminou')
  })

  it('continua lendo', async () => {
    const response = await callApi({ ...admin, method: 'GET', url: '/v1/professionals' })
    expect(response.statusCode).toBe(200)
  })

  it('a rota de assinatura passa pelo bloqueio', async () => {
    const response = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/subscription/checkout',
      payload: {},
    })
    // Qualquer resposta da rota, menos o 423 da sessão: é a escrita que tira daqui.
    expect(response.statusCode).not.toBe(423)
  })
})
