import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createManualEntry } from '../../src/modules/ledger/entries.js'
import {
  actorOf,
  asAdmin,
  asReceptionist,
  balanceOf,
  callApi,
  closeHarness,
  getApp,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

const { setTutorBillingPort } = await import('../../src/modules/ledger/tutor-billing-port.js')
type TutorBillingPort = import('../../src/modules/ledger/tutor-billing-port.js').TutorBillingPort
type CheckoutRequest = import('../../src/modules/ledger/tutor-billing-port.js').CheckoutRequest
const { setLedgerMessagingPort } = await import('../../src/modules/ledger/messaging-port.js')
type ChargeLinkMessage = import('../../src/modules/ledger/messaging-port.js').ChargeLinkMessage
const { expireCharges } = await import('../../src/modules/ledger/tutor-charges.js')
const { AsaasHttpError } = await import('../../src/shared/asaas-http.js')

/**
 * A cobrança online do tutor, pela conta do Asaas do estabelecimento.
 *
 * O Asaas é dublado — a suíte não cobra ninguém. O que se prova é o que é nosso: a
 * conexão que só grava com o webhook cadastrado, o link que não duplica, a baixa que entra
 * uma vez só pelo mesmo caminho do balcão, e o token que diz de qual petshop é o evento.
 */

const CHAVE = '$aact_chave_de_teste_do_petshop_0001'

interface FakeAsaas {
  accepted: boolean
  checkouts: CheckoutRequest[]
  webhooks: { url: string; authToken: string }[]
  removed: string[]
  failCheckoutWith: number | null
  /** O corpo do erro, como o Asaas o devolve. */
  failCheckoutBody: string
}

function installFakeAsaas(): FakeAsaas {
  const fake: FakeAsaas = {
    accepted: true,
    checkouts: [],
    webhooks: [],
    removed: [],
    failCheckoutWith: null,
    failCheckoutBody: 'recusado',
  }
  const port: TutorBillingPort = {
    async validate() {
      return fake.accepted
    },
    async registerWebhook(_key, _env, input) {
      fake.webhooks.push({ url: input.url, authToken: input.authToken })
      return { webhookId: `wh_${fake.webhooks.length}` }
    },
    async removeWebhook(_key, _env, webhookId) {
      fake.removed.push(webhookId)
    },
    async createCheckout(_key, _env, input) {
      if (fake.failCheckoutWith) throw new AsaasHttpError(fake.failCheckoutWith, fake.failCheckoutBody)
      fake.checkouts.push(input)
      return {
        checkoutId: `chk_${fake.checkouts.length}`,
        url: `https://sandbox.asaas.com/checkoutSession/show?id=chk_${fake.checkouts.length}`,
      }
    },
  }
  setTutorBillingPort(port)
  return fake
}

let tenant: TenantFixture
let tutorId: string
let asaas: FakeAsaas
let enviadas: ChargeLinkMessage[]

beforeEach(async () => {
  await resetDatabase()
  asaas = installFakeAsaas()
  enviadas = []
  setLedgerMessagingPort({
    async sendChargeLink(message) {
      enviadas.push(message)
      return true
    },
  })
  tenant = await givenTenant()
  tutorId = await givenTutor(tenant)
})

afterAll(async () => {
  setTutorBillingPort(null)
  setLedgerMessagingPort(null)
  await closeHarness()
})

async function conectar(environment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX') {
  return callApi({
    ...asAdmin(tenant),
    method: 'PUT',
    url: '/v1/billing-settings/asaas',
    payload: { apiKey: CHAVE, environment },
  })
}

async function dever(amountCents: number) {
  await createManualEntry(
    actorOf(tenant),
    {
      tutorId,
      direction: 'DEBIT',
      amountCents,
      category: 'SERVICE',
      description: 'Banho',
      occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    { canCredit: true },
  )
}

async function gerar(payload: Record<string, unknown> = {}) {
  return callApi({
    ...(await asReceptionist(tenant)),
    method: 'POST',
    url: `/v1/ledger/accounts/${tutorId}/charges`,
    payload,
  })
}

async function webhook(token: string, payload: Record<string, unknown>) {
  const app = await getApp()
  return app.inject({
    method: 'POST',
    url: '/internal/v1/asaas/tutor-webhook',
    headers: { 'asaas-access-token': token },
    payload,
  })
}

function tokenDoWebhook(): string {
  const last = asaas.webhooks.at(-1)
  if (!last) throw new Error('nenhum webhook cadastrado')
  return last.authToken
}

describe('a conexão com o Asaas do petshop', () => {
  it('confere a chave, cadastra a baixa automática e grava só o que a tela pode ver', async () => {
    const response = await conectar()

    expect(response.statusCode).toBe(200)
    expect(response.json().connection).toMatchObject({ environment: 'SANDBOX', last4: '0001' })
    expect(JSON.stringify(response.json())).not.toContain(CHAVE)
    expect(asaas.webhooks).toHaveLength(1)
    expect(asaas.webhooks[0]!.url).toContain('/internal/v1/asaas/tutor-webhook')

    const linha = await ownerPrisma.billingSettings.findUniqueOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(linha.asaasApiKeyEncrypted).not.toContain(CHAVE)
    expect(linha.asaasWebhookTokenHash).not.toBe(tokenDoWebhook())
  })

  it('a chave recusada não grava nem cadastra webhook', async () => {
    asaas.accepted = false
    const response = await conectar()

    expect(response.statusCode).toBe(422)
    expect(asaas.webhooks).toHaveLength(0)
  })

  it('a recepção não conecta', async () => {
    const response = await callApi({
      ...(await asReceptionist(tenant)),
      method: 'PUT',
      url: '/v1/billing-settings/asaas',
      payload: { apiKey: CHAVE, environment: 'SANDBOX' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('reconectar tira o webhook antigo da conta', async () => {
    await conectar()
    await conectar('PRODUCTION')

    expect(asaas.removed).toEqual(['wh_1'])
  })

  it('desconectar cancela as cobranças em aberto e tira o webhook', async () => {
    await conectar()
    await dever(5000)
    const { charge } = (await gerar()).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: '/v1/billing-settings/asaas',
    })

    expect(response.json().connection).toBeNull()
    expect(asaas.removed).toEqual(['wh_1'])
    const linha = await ownerPrisma.tutorCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(linha.status).toBe('CANCELLED')
  })
})

describe('o link de pagamento', () => {
  it('sem Asaas conectado, não há link', async () => {
    await dever(5000)
    expect((await gerar()).statusCode).toBe(409)
  })

  it('sem nada em aberto, não há o que cobrar', async () => {
    await conectar()
    expect((await gerar()).statusCode).toBe(409)
  })

  it('cobra o saldo devedor inteiro, com o id da cobrança como referência', async () => {
    await conectar()
    await dever(15000)

    const response = await gerar()

    expect(response.statusCode).toBe(201)
    const { charge, created } = response.json()
    expect(created).toBe(true)
    expect(charge).toMatchObject({ amountCents: 15000, status: 'PENDING', origin: 'ADMIN' })
    expect(asaas.checkouts[0]).toMatchObject({ valueCents: 15000, externalReference: charge.id })
  })

  it('o prazo do link cabe no teto do Checkout do Asaas', async () => {
    // O Asaas recusa `minutesToExpire` acima de 1.440 com `invalid_object`, e o dublê não
    // recusaria: a primeira versão pedia 4.320 e nenhum link nascia no sandbox.
    await conectar()
    await dever(15000)

    await gerar()

    expect(asaas.checkouts[0]!.minutesToExpire).toBeGreaterThanOrEqual(10)
    expect(asaas.checkouts[0]!.minutesToExpire).toBeLessThanOrEqual(1440)
  })

  it('a conta sem chave Pix diz o que falta, e não tira o botão do Portal', async () => {
    await conectar()
    await dever(15000)
    asaas.failCheckoutWith = 400
    asaas.failCheckoutBody = JSON.stringify({
      errors: [
        {
          code: 'invalid_object',
          description: 'Para gerar cobranças com Pix é necessário criar uma chave Pix no Asaas.',
        },
      ],
    })

    const response = await gerar()

    expect(response.statusCode).toBe(409)
    expect(JSON.stringify(response.json())).toContain('Minhas chaves')
    const conexao = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/billing-settings/asaas',
    })
    expect(conexao.json().connection.error).toBeNull()
  })

  it('pedir de novo devolve o mesmo link, e não um segundo checkout', async () => {
    await conectar()
    await dever(15000)

    const primeira = (await gerar()).json()
    const segunda = await gerar()

    expect(segunda.statusCode).toBe(200)
    expect(segunda.json().created).toBe(false)
    expect(segunda.json().charge.id).toBe(primeira.charge.id)
    expect(asaas.checkouts).toHaveLength(1)
  })

  it('manda o link ao tutor quando a recepção pede', async () => {
    await conectar()
    await dever(15000)

    const response = await gerar({ send: true })

    expect(response.json().sent).toBe(true)
    expect(enviadas[0]).toMatchObject({ tutorId })
    expect(enviadas[0]!.variables['financeiro.valor_cobrado']).toContain('150,00')
    expect(enviadas[0]!.variables['cobranca.link']).toContain('chk_1')
  })

  it('a chave recusada pelo Asaas vira aviso, e o botão do Portal some', async () => {
    await conectar()
    await dever(15000)
    asaas.failCheckoutWith = 401

    const response = await gerar()

    expect(response.statusCode).toBe(409)
    const conexao = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/billing-settings/asaas',
    })
    expect(conexao.json().connection.error).toContain('401')
  })
})

describe('a baixa pelo webhook', () => {
  async function cobrancaPaga(event = 'PAYMENT_RECEIVED', billingType = 'PIX') {
    await conectar()
    await dever(15000)
    const { charge } = (await gerar()).json()
    const response = await webhook(tokenDoWebhook(), {
      event,
      payment: { id: 'pay_123', externalReference: charge.id, billingType },
    })
    return { charge, response }
  }

  it('dá baixa pelo mesmo caminho do balcão, com o meio online', async () => {
    const { charge, response } = await cobrancaPaga()

    expect(response.statusCode).toBe(200)
    expect(await balanceOf(tenant, tutorId)).toBe(0)

    const linha = await ownerPrisma.tutorCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(linha.status).toBe('PAID')
    const pagamento = await ownerPrisma.payment.findUniqueOrThrow({
      where: { id: linha.paymentId! },
    })
    expect(pagamento.method).toBe('PIX_ONLINE')
    expect(pagamento.externalRef).toBe('pay_123')
    // O recibo nasce como o de qualquer pagamento.
    expect(await ownerPrisma.receipt.count({ where: { paymentId: pagamento.id } })).toBe(1)
  })

  it('cartão entra como cartão online', async () => {
    const { charge } = await cobrancaPaga('PAYMENT_CONFIRMED', 'CREDIT_CARD')
    const linha = await ownerPrisma.tutorCharge.findUniqueOrThrow({ where: { id: charge.id } })
    const pagamento = await ownerPrisma.payment.findUniqueOrThrow({
      where: { id: linha.paymentId! },
    })
    expect(pagamento.method).toBe('CARD_ONLINE')
  })

  it('o par CONFIRMED + RECEIVED do mesmo pagamento grava um pagamento só', async () => {
    const { charge } = await cobrancaPaga('PAYMENT_CONFIRMED')
    await webhook(tokenDoWebhook(), {
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_123', externalReference: charge.id, billingType: 'PIX' },
    })

    expect(await ownerPrisma.payment.count({ where: { tenantId: tenant.tenantId } })).toBe(1)
    expect(await balanceOf(tenant, tutorId)).toBe(0)
  })

  it('token que não é de petshop nenhum é recusado', async () => {
    const response = await webhook('token-inventado', {
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1', externalReference: randomUUID() },
    })
    expect(response.statusCode).toBe(401)
  })

  it('o token de um petshop não paga a cobrança de outro', async () => {
    const { charge } = await cobrancaPaga()
    const tokenDoPrimeiro = tokenDoWebhook()

    const outro = await givenTenant('Outro Petshop')
    const tutorDoOutro = await givenTutor(outro)
    await callApi({
      ...asAdmin(outro),
      method: 'PUT',
      url: '/v1/billing-settings/asaas',
      payload: { apiKey: CHAVE, environment: 'SANDBOX' },
    })
    await createManualEntry(
      actorOf(outro),
      {
        tutorId: tutorDoOutro,
        direction: 'DEBIT',
        amountCents: 3000,
        category: 'SERVICE',
        description: 'Banho',
        occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )
    const cobrancaDoOutro = (
      await callApi({
        ...(await asReceptionist(outro)),
        method: 'POST',
        url: `/v1/ledger/accounts/${tutorDoOutro}/charges`,
        payload: {},
      })
    ).json().charge

    // O evento chega com o token do primeiro petshop e a referência do segundo.
    await webhook(tokenDoPrimeiro, {
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_999', externalReference: cobrancaDoOutro.id, billingType: 'PIX' },
    })

    const linha = await ownerPrisma.tutorCharge.findUniqueOrThrow({
      where: { id: cobrancaDoOutro.id },
    })
    expect(linha.status).toBe('PENDING')
    expect(charge.id).not.toBe(cobrancaDoOutro.id)
  })

  it('pagamento da conta do petshop que não nasceu de cobrança nossa é ignorado', async () => {
    await conectar()
    const response = await webhook(tokenDoWebhook(), {
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_alheio', billingType: 'BOLETO' },
    })
    expect(response.statusCode).toBe(200)
    expect(await ownerPrisma.payment.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  })

  it('a cobrança vencida que o tutor pagou mesmo assim é registrada', async () => {
    await conectar()
    await dever(15000)
    const { charge } = (await gerar()).json()
    await ownerPrisma.tutorCharge.update({
      where: { id: charge.id },
      data: { status: 'EXPIRED' },
    })

    await webhook(tokenDoWebhook(), {
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_tarde', externalReference: charge.id, billingType: 'PIX' },
    })

    const linha = await ownerPrisma.tutorCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(linha.status).toBe('PAID')
    expect(await balanceOf(tenant, tutorId)).toBe(0)
  })

  it('o checkout sem referência é achado pela sessão', async () => {
    await conectar()
    await dever(15000)
    const { charge } = (await gerar()).json()

    await webhook(tokenDoWebhook(), {
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_sessao', checkoutSession: 'chk_1', billingType: 'PIX' },
    })

    const linha = await ownerPrisma.tutorCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(linha.status).toBe('PAID')
  })
})

describe('o vencimento', () => {
  it('vence o que passou do prazo', async () => {
    await conectar()
    await dever(15000)
    const { charge } = (await gerar()).json()

    const result = await expireCharges(new Date(Date.now() + 73 * 3_600_000))

    expect(result.expired).toBe(1)
    const linha = await ownerPrisma.tutorCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(linha.status).toBe('EXPIRED')
  })
})
