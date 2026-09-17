import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  setBillingProviderPort,
  type BillingProviderPort,
} from '../../src/modules/subscription/asaas-port.js'
import { runSuspendOverdueOnce } from '../../src/modules/subscription/overdue.js'
import {
  callApi,
  callPublic,
  closeHarness,
  ownerPrisma,
  resetDatabase,
  seedMember,
  seedTenant,
  type Caller,
  type SeededTenant,
} from '../harness.js'

/**
 * Camada comercial, fatia 4 — a assinatura pelo Asaas.
 *
 * O Asaas é dublado na porta: estes testes provam o que o produto faz com o que o
 * provedor responde e com o que o webhook conta, e não a API do provedor — essa é
 * conferida no sandbox.
 */

const TOKEN = 'asaas-webhook-token-de-teste'
process.env.ASAAS_WEBHOOK_TOKEN = TOKEN

const CPF = '52998224725'
const DIA = 24 * 60 * 60 * 1000

interface Chamadas {
  customers: number
  pix: Array<{ valueCents: number; externalReference: string }>
  checkouts: Array<{ valueCents: number; externalReference: string }>
  updates: Array<{ subscriptionId: string; valueCents: number }>
  cancels: string[]
}

let chamadas: Chamadas
let configurado = true
let tenant: SeededTenant
let admin: Caller
let sequencia = 0

function dublarAsaas(): void {
  chamadas = { customers: 0, pix: [], checkouts: [], updates: [], cancels: [] }
  const porta: BillingProviderPort = {
    configured: () => configurado,
    async createCustomer() {
      chamadas.customers += 1
      return { customerId: `cus_${++sequencia}` }
    },
    async createPixSubscription(input) {
      chamadas.pix.push(input)
      const id = `sub_${++sequencia}`
      return { subscriptionId: id, paymentUrl: `https://sandbox.asaas.com/i/${id}` }
    },
    async createCardCheckout(input) {
      chamadas.checkouts.push(input)
      const id = `chk_${++sequencia}`
      return { checkoutId: id, url: `https://sandbox.asaas.com/checkout/${id}` }
    },
    async updateSubscriptionValue(subscriptionId, valueCents) {
      chamadas.updates.push({ subscriptionId, valueCents })
    },
    async cancelSubscription(subscriptionId) {
      chamadas.cancels.push(subscriptionId)
    },
  }
  setBillingProviderPort(porta)
}

beforeEach(async () => {
  await resetDatabase()
  configurado = true
  dublarAsaas()
  tenant = await seedTenant('petshop-assina', 'TRIAL')
  const membro = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
  admin = { clerkUserId: membro.clerkUserId, clerkOrgId: tenant.clerkOrgId }
})

afterAll(async () => {
  setBillingProviderPort(null)
  await closeHarness()
})

function assinar(body: Record<string, unknown>) {
  return callApi({ ...admin, method: 'POST', url: '/v1/subscription/checkout', payload: body })
}

let eventos = 0
function webhook(body: Record<string, unknown>, token = TOKEN) {
  return callPublic({
    method: 'POST',
    url: '/internal/v1/asaas/webhook',
    headers: { 'asaas-access-token': token },
    payload: { id: `evt_${++eventos}`, ...body },
  })
}

async function linha() {
  return ownerPrisma.tenantSubscription.findUnique({ where: { tenantId: tenant.tenantId } })
}

async function conta() {
  return ownerPrisma.tenant.findUnique({ where: { id: tenant.tenantId } })
}

describe('começar a assinatura', () => {
  it('PIX: cria cliente e assinatura com o preço do catálogo, e não muda nada antes de pagar', async () => {
    const response = await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })

    expect(response.statusCode).toBe(201)
    expect(response.json().paymentUrl).toMatch(/^https:\/\/sandbox\.asaas\.com\/i\//)
    expect(chamadas.customers).toBe(1)
    expect(chamadas.pix).toEqual([
      expect.objectContaining({ valueCents: 29_900, externalReference: tenant.tenantId }),
    ])

    expect(await linha()).toMatchObject({ plan: 'PRO', method: 'PIX', status: 'PENDING' })
    // Escolher não é pagar.
    expect(await conta()).toMatchObject({ plan: 'STARTER', status: 'TRIAL' })
  })

  it('cartão: passa pelo checkout, sem cliente criado por nós', async () => {
    const response = await assinar({ plan: 'STARTER', method: 'CREDIT_CARD', cpfCnpj: CPF })

    expect(response.statusCode).toBe(201)
    expect(chamadas.customers).toBe(0)
    expect(chamadas.checkouts).toEqual([expect.objectContaining({ valueCents: 14_900 })])
    expect((await linha())?.providerCheckoutId).toMatch(/^chk_/)
  })

  it('recomeçar desfaz a assinatura PIX pendente no Asaas', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const anterior = (await linha())?.providerSubscriptionId

    await assinar({ plan: 'PRO', method: 'CREDIT_CARD', cpfCnpj: CPF })

    expect(chamadas.cancels).toEqual([anterior])
    expect(await linha()).toMatchObject({ method: 'CREDIT_CARD', providerSubscriptionId: null })
  })

  it('recusa Enterprise, documento inválido e instalação sem Asaas', async () => {
    expect((await assinar({ plan: 'ENTERPRISE', method: 'PIX', cpfCnpj: CPF })).statusCode).toBe(
      422,
    )
    expect((await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: '11111111111' })).statusCode).toBe(
      422,
    )
    expect((await assinar({ plan: 'PRO', method: 'BOLETO', cpfCnpj: CPF })).statusCode).toBe(422)

    configurado = false
    const semAsaas = await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    expect(semAsaas.statusCode).toBe(503)
    expect(semAsaas.json().code).toBe('ERR_SUB_004')
  })

  it('a recepção não assina', async () => {
    const recepcao = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const response = await callApi({
      clerkUserId: recepcao.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
      method: 'POST',
      url: '/v1/subscription/checkout',
      payload: { plan: 'PRO', method: 'PIX', cpfCnpj: CPF },
    })
    expect(response.statusCode).toBe(403)
  })

  it('com o teste vencido, assinar continua possível', async () => {
    await ownerPrisma.tenant.update({
      where: { id: tenant.tenantId },
      data: { status: 'TRIAL_EXPIRED' },
    })
    expect((await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })).statusCode).toBe(201)
  })
})

describe('o webhook', () => {
  it('sem o token certo, recusa e não toca em nada', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const row = await linha()

    const response = await webhook(
      { event: 'PAYMENT_RECEIVED', payment: { customer: row!.providerCustomerId } },
      'token-errado',
    )

    expect(response.statusCode).toBe(401)
    expect((await linha())?.status).toBe('PENDING')
  })

  it('PIX pago: o plano contratado entra em vigor e o teste vira conta ativa', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const row = await linha()

    const response = await webhook({
      event: 'PAYMENT_CONFIRMED',
      payment: { customer: row!.providerCustomerId, subscription: row!.providerSubscriptionId },
    })

    expect(response.statusCode).toBe(200)
    expect(await linha()).toMatchObject({ status: 'ACTIVE', paymentUrl: null })
    expect(await conta()).toMatchObject({ plan: 'PRO', status: 'ACTIVE' })
  })

  it('cartão: o cliente chega pelo checkout, e a cobrança seguinte acha o estabelecimento', async () => {
    await ownerPrisma.tenant.update({
      where: { id: tenant.tenantId },
      data: { status: 'TRIAL_EXPIRED' },
    })
    await assinar({ plan: 'STARTER', method: 'CREDIT_CARD', cpfCnpj: CPF })
    const row = await linha()

    await webhook({
      event: 'CHECKOUT_CREATED',
      checkout: { id: row!.providerCheckoutId, customer: 'cus_do_checkout' },
    })
    expect((await linha())?.providerCustomerId).toBe('cus_do_checkout')

    await webhook({
      event: 'PAYMENT_RECEIVED',
      payment: { customer: 'cus_do_checkout', subscription: 'sub_do_cartao' },
    })

    expect(await linha()).toMatchObject({
      status: 'ACTIVE',
      providerSubscriptionId: 'sub_do_cartao',
    })
    expect(await conta()).toMatchObject({ status: 'ACTIVE' })
  })

  it('o mesmo evento duas vezes vale uma', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const row = await linha()
    const corpo = {
      id: 'evt_repetido',
      event: 'PAYMENT_CONFIRMED',
      payment: { customer: row!.providerCustomerId },
    }

    await callPublic({
      method: 'POST',
      url: '/internal/v1/asaas/webhook',
      headers: { 'asaas-access-token': TOKEN },
      payload: corpo,
    })
    await callPublic({
      method: 'POST',
      url: '/internal/v1/asaas/webhook',
      headers: { 'asaas-access-token': TOKEN },
      payload: corpo,
    })

    const trilha = await ownerPrisma.auditLog.count({
      where: { tenantId: tenant.tenantId, action: 'subscription.activated' },
    })
    expect(trilha).toBe(1)
  })

  it('a cobrança de uma assinatura substituída não ativa nada', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const antiga = await linha()
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })

    await webhook({
      event: 'PAYMENT_RECEIVED',
      payment: {
        customer: antiga!.providerCustomerId,
        subscription: antiga!.providerSubscriptionId,
      },
    })

    expect((await linha())?.status).toBe('PENDING')
    expect((await conta())?.status).toBe('TRIAL')
  })

  it('evento de estabelecimento desconhecido responde 200 e é ignorado', async () => {
    const response = await webhook({
      event: 'PAYMENT_RECEIVED',
      payment: { customer: 'cus_de_ninguem' },
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('atraso e carência', () => {
  async function assinaturaPaga() {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const row = await linha()
    await webhook({ event: 'PAYMENT_CONFIRMED', payment: { customer: row!.providerCustomerId } })
    return row!
  }

  it('vencida, a conta fica em atraso e continua gravando', async () => {
    const row = await assinaturaPaga()
    await webhook({
      event: 'PAYMENT_OVERDUE',
      payment: {
        customer: row.providerCustomerId,
        dueDate: '2026-09-10',
        invoiceUrl: 'https://sandbox.asaas.com/i/atraso',
      },
    })

    expect(await linha()).toMatchObject({
      status: 'PAST_DUE',
      paymentUrl: 'https://sandbox.asaas.com/i/atraso',
    })
    expect((await conta())?.status).toBe('PAST_DUE')

    const escrita = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/services',
      payload: { name: 'Banho', category: 'BATH', baseDurationMin: 60 },
    })
    expect(escrita.statusCode).not.toBe(423)
  })

  it('passada a carência, fica só em leitura; pagando, volta', async () => {
    const row = await assinaturaPaga()
    await webhook({ event: 'PAYMENT_OVERDUE', payment: { customer: row.providerCustomerId } })
    await ownerPrisma.tenantSubscription.update({
      where: { tenantId: tenant.tenantId },
      data: { overdueSince: new Date(Date.now() - 8 * DIA) },
    })

    expect(await runSuspendOverdueOnce()).toBe(1)
    expect((await conta())?.status).toBe('SUSPENDED')

    await webhook({ event: 'PAYMENT_RECEIVED', payment: { customer: row.providerCustomerId } })
    expect((await conta())?.status).toBe('ACTIVE')
  })

  it('dentro da carência, nada muda', async () => {
    const row = await assinaturaPaga()
    await webhook({ event: 'PAYMENT_OVERDUE', payment: { customer: row.providerCustomerId } })

    expect(await runSuspendOverdueOnce()).toBe(0)
  })

  it('assinatura cancelada suspende quando o mês pago acaba', async () => {
    const row = await assinaturaPaga()
    await webhook({
      event: 'SUBSCRIPTION_DELETED',
      subscription: { id: row.providerSubscriptionId },
    })
    expect((await linha())?.status).toBe('CANCELED')
    expect(await runSuspendOverdueOnce()).toBe(0)

    await ownerPrisma.tenantSubscription.update({
      where: { tenantId: tenant.tenantId },
      data: { lastPaidAt: new Date(Date.now() - 32 * DIA) },
    })
    expect(await runSuspendOverdueOnce()).toBe(1)
    expect((await conta())?.status).toBe('SUSPENDED')
  })
})

describe('trocar de plano', () => {
  it('no teste, troca sem cobrar', async () => {
    const response = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/subscription/plan',
      payload: { plan: 'PRO' },
    })

    expect(response.statusCode).toBe(200)
    expect((await conta())?.plan).toBe('PRO')
    expect(chamadas.updates).toHaveLength(0)
  })

  it('assinado, muda o valor no Asaas e o plano na hora', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const row = await linha()
    await webhook({ event: 'PAYMENT_CONFIRMED', payment: { customer: row!.providerCustomerId } })

    const response = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/subscription/plan',
      payload: { plan: 'STARTER' },
    })

    expect(response.statusCode).toBe(200)
    expect(chamadas.updates).toEqual([
      { subscriptionId: row!.providerSubscriptionId, valueCents: 14_900 },
    ])
    expect((await conta())?.plan).toBe('STARTER')
    expect((await linha())?.plan).toBe('STARTER')
  })

  it('assinado, não assina de novo por cima', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })
    const row = await linha()
    await webhook({ event: 'PAYMENT_CONFIRMED', payment: { customer: row!.providerCustomerId } })

    const response = await assinar({ plan: 'STARTER', method: 'PIX', cpfCnpj: CPF })
    expect(response.statusCode).toBe(409)
  })
})

describe('a leitura', () => {
  it('mostra plano, estado e a assinatura em curso', async () => {
    await assinar({ plan: 'PRO', method: 'PIX', cpfCnpj: CPF })

    const response = await callApi({ ...admin, method: 'GET', url: '/v1/subscription' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tenantStatus: 'TRIAL',
      plan: 'STARTER',
      configured: true,
      subscription: { plan: 'PRO', method: 'PIX', status: 'PENDING' },
    })
  })
})
