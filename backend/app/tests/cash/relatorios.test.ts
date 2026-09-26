import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  callApi,
  chave,
  closeHarness,
  givenTenant,
  givenTutor,
  resetDatabase,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * Os relatórios do caixa — por período, por forma de pagamento e por tutor.
 *
 * O contrato: os três recortes somam o mesmo dinheiro, o estorno desconta do valor e não
 * da contagem, e troco, sangria e suprimento nunca viram recebido.
 */

let fixture: TenantFixture
let admin: Caller

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  admin = asAdmin(fixture)
})

afterAll(closeHarness)

async function post(url: string, payload: Record<string, unknown>) {
  const resposta = await callApi({ ...admin, method: 'POST', url, payload })
  expect(resposta.statusCode, resposta.body).toBeLessThan(300)
  return resposta.json()
}

async function relatorio(query = '', caller: Caller = admin) {
  return callApi({ ...caller, method: 'GET', url: `/v1/cash/reports${query}` })
}

async function racao(): Promise<string> {
  const produto = await post('/v1/inventory/products', {
    name: 'Ração 15 kg',
    kind: 'RETAIL',
    salePriceCents: 25_000,
  })
  await post('/v1/inventory/entries', {
    productId: produto.id,
    quantity: '10',
    idempotencyKey: chave(),
  })
  return produto.id as string
}

async function pagar(tutorId: string, amountCents: number, method = 'CASH') {
  return post('/v1/payments', {
    tutorId,
    amountCents,
    method,
    receivedAt: new Date().toISOString(),
    idempotencyKey: randomUUID(),
  })
}

describe('relatórios do caixa', () => {
  it('sem movimento, o período vem vazio e aponta para o mês corrente', async () => {
    const resposta = await relatorio()

    expect(resposta.statusCode, resposta.body).toBe(200)
    const corpo = resposta.json()
    expect(corpo.from.slice(8)).toBe('01')
    expect(corpo.days).toEqual([])
    expect(corpo.byMethod).toEqual([])
    expect(corpo.byTutor).toEqual([])
    expect(corpo.totals.receivedCents).toBe(0)
  })

  it('os três recortes somam o mesmo dinheiro, e a gaveta fica fora do recebido', async () => {
    await post('/v1/cash/sessions', { openingFloatCents: 10_000 })
    const produto = await racao()
    const tutorId = await givenTutor(fixture)

    await post('/v1/inventory/sales', {
      idempotencyKey: chave(),
      items: [{ productId: produto, quantity: '1' }],
      paymentMethod: 'PIX_MANUAL',
    })
    await pagar(tutorId, 8_000, 'CASH')
    const estornado = await pagar(tutorId, 3_000, 'CASH')
    await post(`/v1/payments/${estornado.id}/reverse`, { reason: 'Lançado em dobro' })
    await post('/v1/cash/adjustments', { type: 'WITHDRAWAL', amountCents: 5_000, reason: 'Cofre' })
    await post('/v1/cash/adjustments', { type: 'DEPOSIT', amountCents: 2_000, reason: 'Troco' })

    const resposta = await relatorio()
    expect(resposta.statusCode, resposta.body).toBe(200)
    const corpo = resposta.json()

    expect(corpo.totals).toMatchObject({
      walkInCents: 25_000,
      tutorPaymentsCents: 8_000,
      receivedCents: 33_000,
      count: 3,
      withdrawalsCents: 5_000,
      depositsCents: 2_000,
      sessionsCount: 1,
    })

    expect(corpo.days).toHaveLength(1)
    expect(corpo.days[0]).toMatchObject({ receivedCents: 33_000, withdrawalsCents: 5_000 })

    expect(corpo.byMethod).toEqual([
      {
        method: 'PIX_MANUAL',
        walkInCents: 25_000,
        tutorPaymentsCents: 0,
        receivedCents: 25_000,
        count: 1,
      },
      { method: 'CASH', walkInCents: 0, tutorPaymentsCents: 8_000, receivedCents: 8_000, count: 2 },
    ])

    expect(corpo.byTutor).toEqual([
      expect.objectContaining({
        tutorId,
        tutorName: 'Maria Silva',
        count: 2,
        receivedCents: 8_000,
        methods: ['CASH'],
      }),
    ])
  })

  it('o período fora do movimento não o traz', async () => {
    await post('/v1/cash/sessions', { openingFloatCents: 0 })
    await pagar(await givenTutor(fixture), 8_000)

    const resposta = await relatorio('?from=2020-01-01&to=2020-01-31')

    expect(resposta.statusCode, resposta.body).toBe(200)
    expect(resposta.json().totals.receivedCents).toBe(0)
    expect(resposta.json().byTutor).toEqual([])
  })

  it('recusa período invertido ou maior que um ano', async () => {
    const invertido = await relatorio('?from=2026-02-01&to=2026-01-01')
    expect(invertido.statusCode).toBe(422)
    expect(invertido.json().code).toBe('ERR_CASH_002')

    const longo = await relatorio('?from=2024-01-01&to=2026-01-01')
    expect(longo.statusCode).toBe(422)
  })

  it('a recepção lê; quem dá banho não', async () => {
    expect((await relatorio('', await asRole(fixture, 'RECEPTIONIST'))).statusCode).toBe(200)

    const banhista = await relatorio('', await asRole(fixture, 'BATHER'))
    expect(banhista.statusCode).toBe(403)
  })

  it('o Starter recebe 402', async () => {
    const starter = await givenTenant('STARTER')
    expect((await relatorio('', asAdmin(starter))).statusCode).toBe(402)
  })
})
