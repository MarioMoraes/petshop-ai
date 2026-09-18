import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PLAN_CATALOG } from '@petshop/shared-types'
import { setBillingProviderPort } from '../../src/modules/subscription/asaas-port.js'
import {
  callApi,
  callPlatform,
  callPublic,
  closeHarness,
  givenPlatformAdmin,
  givenTenantWithAdmin,
  ownerPrisma,
  platformAuditLines,
  resetDatabase,
  seedMember,
  type PlatformUser,
  type TenantWithAdmin,
} from './fixtures.js'

/**
 * A tabela de preços do console (camada comercial).
 *
 * O que estes testes protegem, mais do que a rota, é a **promessa do grandfathering**: o
 * preço de tabela é o de quem chega, e mexer nele não pode alcançar quem já assina. Um
 * defeito ali não aparece em erro nenhum — aparece na fatura do cliente.
 */

const MOTIVO = 'Reajuste anual combinado em 18/09'
const CPF = '52998224725'

let equipe: PlatformUser
let petshop: TenantWithAdmin

beforeEach(async () => {
  await resetDatabase()
  equipe = await givenPlatformAdmin('Equipe Comercial')
  petshop = await givenTenantWithAdmin('petshop-do-joao')
})

afterAll(async () => {
  setBillingProviderPort(null)
  await closeHarness()
})

function listar(user = equipe) {
  return callPlatform({ url: '/platform/v1/plans', user })
}

function mudar(plan: string, body: Record<string, unknown>) {
  return callPlatform({
    method: 'PUT',
    url: `/platform/v1/plans/${plan}`,
    user: equipe,
    payload: { reason: MOTIVO, ...body },
  })
}

describe('a tabela de preços', () => {
  it('sem ninguém ter mexido, responde o padrão do catálogo', async () => {
    const response = await listar()

    expect(response.statusCode).toBe(200)
    const starter = response.json().items.find((item: { plan: string }) => item.plan === 'STARTER')
    expect(starter).toMatchObject({
      monthlyCents: PLAN_CATALOG.STARTER.priceCents,
      yearlyCents: PLAN_CATALOG.STARTER.priceYearlyCents,
      defaultMonthlyCents: PLAN_CATALOG.STARTER.priceCents,
      // `null` é o que diz "ninguém mexeu" — e é diferente de terem escolhido o padrão.
      updatedAt: null,
    })
  })

  it('o Enterprise aparece sem preço e não aceita um', async () => {
    const enterprise = (await listar())
      .json()
      .items.find((item: { plan: string }) => item.plan === 'ENTERPRISE')
    expect(enterprise).toMatchObject({ monthlyCents: null, yearlyCents: null })

    const response = await mudar('ENTERPRISE', { monthlyCents: 99_900, yearlyCents: 959_000 })
    expect(response.statusCode).toBe(409)
  })

  it('muda o preço, registra na trilha da plataforma e devolve o novo', async () => {
    const response = await mudar('PRO', { monthlyCents: 34_900, yearlyCents: 335_000 })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      plan: 'PRO',
      monthlyCents: 34_900,
      yearlyCents: 335_000,
      defaultMonthlyCents: PLAN_CATALOG.PRO.priceCents,
    })

    const trilha = await platformAuditLines()
    expect(trilha.find((linha) => linha.action === 'platform.plan_price_changed')).toBeTruthy()
  })

  it('recusa anuidade que não sai mais barata que doze mensalidades', async () => {
    const response = await mudar('PRO', { monthlyCents: 29_900, yearlyCents: 358_800 })
    expect(response.statusCode).toBe(409)
  })

  it('recusa preço zerado e motivo curto', async () => {
    expect((await mudar('PRO', { monthlyCents: 0, yearlyCents: 0 })).statusCode).toBe(422)
    expect(
      (
        await callPlatform({
          method: 'PUT',
          url: '/platform/v1/plans/PRO',
          user: equipe,
          payload: { monthlyCents: 34_900, yearlyCents: 335_000, reason: 'oi' },
        })
      ).statusCode,
    ).toBe(422)
  })

  it('voltar ao padrão apaga a linha, e não grava o padrão como escolha', async () => {
    await mudar('PRO', { monthlyCents: 34_900, yearlyCents: 335_000 })

    const response = await callPlatform({
      method: 'DELETE',
      url: '/platform/v1/plans/PRO',
      user: equipe,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      monthlyCents: PLAN_CATALOG.PRO.priceCents,
      updatedAt: null,
    })
    expect(await ownerPrisma.planPrice.findUnique({ where: { plan: 'PRO' } })).toBeNull()
  })

  it('quem não é da plataforma não enxerga a tabela', async () => {
    const forasteiro = await givenPlatformAdmin('Ex-membro')
    await ownerPrisma.platformAdmin.deleteMany({ where: { userId: forasteiro.userId } })

    expect((await listar(forasteiro)).statusCode).toBe(404)
  })
})

describe('a landing e o checkout leem a mesma tabela', () => {
  it('a rota pública responde sem sessão e acompanha a mudança', async () => {
    const antes = await callPublic({ method: 'GET', url: '/public/v1/plans' })
    expect(antes.statusCode).toBe(200)
    expect(antes.json().items).toContainEqual({
      plan: 'PRO',
      monthlyCents: PLAN_CATALOG.PRO.priceCents,
      yearlyCents: PLAN_CATALOG.PRO.priceYearlyCents,
    })

    await mudar('PRO', { monthlyCents: 34_900, yearlyCents: 335_000 })

    const depois = await callPublic({ method: 'GET', url: '/public/v1/plans' })
    expect(depois.json().items).toContainEqual({
      plan: 'PRO',
      monthlyCents: 34_900,
      yearlyCents: 335_000,
    })
  })

  it('o checkout cobra o preço novo de quem assina depois da mudança', async () => {
    const cobrancas: number[] = []
    setBillingProviderPort({
      configured: () => true,
      async createCustomer() {
        return { customerId: 'cus_1' }
      },
      async createPixSubscription(input) {
        cobrancas.push(input.valueCents)
        return { subscriptionId: 'sub_1', paymentUrl: 'https://sandbox.asaas.com/i/sub_1' }
      },
      async createCardCheckout() {
        return { checkoutId: 'chk_1', url: 'https://sandbox.asaas.com/checkout/chk_1' }
      },
      async createCharge() {
        return { paymentId: 'pay_1', paymentUrl: null }
      },
      async updateSubscriptionValue() {},
      async cancelSubscription() {},
    })

    await mudar('PRO', { monthlyCents: 34_900, yearlyCents: 335_000 })

    const admin = await seedMember(petshop.tenantId, 'TENANT_ADMIN')
    const response = await callApi({
      clerkUserId: admin.clerkUserId,
      clerkOrgId: petshop.clerkOrgId,
      method: 'POST',
      url: '/v1/subscription/checkout',
      payload: { plan: 'PRO', method: 'PIX', cpfCnpj: CPF },
    })

    expect(response.statusCode).toBe(201)
    expect(cobrancas).toEqual([34_900])

    // **O grandfathering, gravado**: o preço fica congelado na assinatura. Um reajuste
    // depois desta linha não a alcança.
    const linha = await ownerPrisma.tenantSubscription.findUnique({
      where: { tenantId: petshop.tenantId },
    })
    expect(linha?.priceCents).toBe(34_900)

    await mudar('PRO', { monthlyCents: 39_900, yearlyCents: 383_000 })
    const depois = await ownerPrisma.tenantSubscription.findUnique({
      where: { tenantId: petshop.tenantId },
    })
    expect(depois?.priceCents).toBe(34_900)
  })
})
