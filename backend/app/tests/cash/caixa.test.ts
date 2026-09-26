import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  balanceOf,
  callApi,
  chave,
  closeHarness,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-CAIXA — o caixa do dia.
 *
 * O contrato: **o esperado é a soma dos movimentos**, a venda avulsa não acontece sem
 * caixa, o pagamento do tutor nunca depende dele, e o fechamento congela a contagem —
 * com justificativa quando ela não bate.
 */

let fixture: TenantFixture
let admin: Caller

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  admin = asAdmin(fixture)
})

afterAll(closeHarness)

// ─── Ajudantes ───────────────────────────────────────────────────────────────

interface Sessao {
  id: string
  status: 'OPEN' | 'CLOSED'
  byMethod: { method: string; expectedCents: number; countedCents: number | null }[]
  receivedCents: number
  differenceCents: number | null
  movements: { type: string; method: string; amountCents: number; description: string }[]
}

function esperado(sessao: Sessao, method = 'CASH'): number {
  return sessao.byMethod.find((row) => row.method === method)?.expectedCents ?? 0
}

async function abrir(openingFloatCents = 10_000, caller: Caller = admin): Promise<Sessao> {
  const resposta = await callApi({
    ...caller,
    method: 'POST',
    url: '/v1/cash/sessions',
    payload: { openingFloatCents },
  })
  expect(resposta.statusCode, resposta.body).toBe(201)
  return resposta.json() as Sessao
}

async function atual(): Promise<Sessao | null> {
  const resposta = await callApi({ ...admin, method: 'GET', url: '/v1/cash/current' })
  expect(resposta.statusCode, resposta.body).toBe(200)
  return resposta.json().session as Sessao | null
}

async function ajuste(corpo: Record<string, unknown>) {
  return callApi({ ...admin, method: 'POST', url: '/v1/cash/adjustments', payload: corpo })
}

async function fechar(id: string, corpo: Record<string, unknown>) {
  return callApi({
    ...admin,
    method: 'POST',
    url: `/v1/cash/sessions/${id}/close`,
    payload: corpo,
  })
}

async function racao(quantidade = '10'): Promise<string> {
  const produto = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/products',
    payload: { name: 'Ração 15 kg', kind: 'RETAIL', salePriceCents: 25_000 },
  })
  const id = produto.json().id as string
  await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/entries',
    payload: { productId: id, quantity: quantidade, idempotencyKey: chave() },
  })
  return id
}

async function vender(corpo: Record<string, unknown>) {
  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/sales',
    payload: { idempotencyKey: chave(), ...corpo },
  })
}

async function pagar(tutorId: string, amountCents: number, extra: Record<string, unknown> = {}) {
  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/payments',
    payload: {
      tutorId,
      amountCents,
      method: 'CASH',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
      ...extra,
    },
  })
}

// ─── A sessão ────────────────────────────────────────────────────────────────

describe('a sessão de caixa', () => {
  it('sem caixa aberto, o atual é nulo', async () => {
    expect(await atual()).toBeNull()
  })

  it('abre com o troco como primeiro movimento em dinheiro', async () => {
    const sessao = await abrir(10_000)

    expect(sessao.status).toBe('OPEN')
    expect(esperado(sessao)).toBe(10_000)
    expect(sessao.receivedCents).toBe(0)
    expect(sessao.movements.map((row) => row.type)).toEqual(['OPENING_FLOAT'])
    expect((await atual())?.id).toBe(sessao.id)
  })

  it('um caixa aberto por estabelecimento', async () => {
    await abrir()
    const segundo = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/cash/sessions',
      payload: { openingFloatCents: 0 },
    })
    expect(segundo.statusCode).toBe(409)
    expect(segundo.json().code).toBe('ERR_CASH_003')
  })

  it('sangria tira da gaveta, suprimento põe, e os dois pedem motivo', async () => {
    await abrir(10_000)

    const semMotivo = await ajuste({ type: 'WITHDRAWAL', amountCents: 1_000, reason: '' })
    expect(semMotivo.statusCode).toBe(422)

    expect((await ajuste({ type: 'DEPOSIT', amountCents: 5_000, reason: 'Troco' })).statusCode).toBe(201)
    const sangria = await ajuste({ type: 'WITHDRAWAL', amountCents: 12_000, reason: 'Cofre' })
    expect(sangria.statusCode, sangria.body).toBe(201)

    // 100 de troco + 50 de suprimento − 120 para o cofre.
    expect(esperado(sangria.json() as Sessao)).toBe(3_000)
  })

  it('a sangria não tira mais dinheiro do que a gaveta tem', async () => {
    await abrir(10_000)
    const resposta = await ajuste({ type: 'WITHDRAWAL', amountCents: 10_001, reason: 'Cofre' })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_CASH_008')
  })

  it('sem caixa aberto não há sangria', async () => {
    const resposta = await ajuste({ type: 'WITHDRAWAL', amountCents: 100, reason: 'Cofre' })
    expect(resposta.statusCode).toBe(409)
    expect(resposta.json().code).toBe('ERR_CASH_004')
  })

  it('fecha com a contagem batendo, e o caixa sai do atual para o histórico', async () => {
    const sessao = await abrir(10_000)

    const resposta = await fechar(sessao.id, { counts: [{ method: 'CASH', countedCents: 10_000 }] })

    expect(resposta.statusCode, resposta.body).toBe(200)
    const fechada = resposta.json() as Sessao
    expect(fechada.status).toBe('CLOSED')
    expect(fechada.differenceCents).toBe(0)
    expect(fechada.byMethod).toEqual([
      { method: 'CASH', expectedCents: 10_000, countedCents: 10_000 },
    ])
    expect(await atual()).toBeNull()

    const historico = await callApi({ ...admin, method: 'GET', url: '/v1/cash/sessions' })
    expect(historico.json().items.map((row: Sessao) => row.id)).toEqual([sessao.id])
  })

  it('não fecha sem contar o dinheiro', async () => {
    const sessao = await abrir()
    const resposta = await fechar(sessao.id, { counts: [] })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_CASH_002')
  })

  it('diferença exige justificativa, e fica gravada', async () => {
    const sessao = await abrir(10_000)

    const semNota = await fechar(sessao.id, { counts: [{ method: 'CASH', countedCents: 9_500 }] })
    expect(semNota.statusCode).toBe(422)
    expect(semNota.json().code).toBe('ERR_CASH_006')

    const comNota = await fechar(sessao.id, {
      counts: [{ method: 'CASH', countedCents: 9_500 }],
      notes: 'Troco errado para um cliente',
    })
    expect(comNota.statusCode, comNota.body).toBe(200)
    expect(comNota.json().differenceCents).toBe(-500)

    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId, action: 'cash.closed' },
    })
    expect(trilha?.after).toMatchObject({ differenceCents: -500 })
  })

  it('caixa fechado não fecha de novo', async () => {
    const sessao = await abrir(0)
    await fechar(sessao.id, { counts: [{ method: 'CASH', countedCents: 0 }] })
    const segunda = await fechar(sessao.id, { counts: [{ method: 'CASH', countedCents: 0 }] })
    expect(segunda.statusCode).toBe(409)
    expect(segunda.json().code).toBe('ERR_CASH_005')
  })

  it('a forma não conferida fica sem contagem e fora da diferença', async () => {
    const sessao = await abrir(0)
    const produto = await racao()
    await vender({ items: [{ productId: produto, quantity: '1' }], paymentMethod: 'PIX_MANUAL' })

    const resposta = await fechar(sessao.id, { counts: [{ method: 'CASH', countedCents: 0 }] })

    expect(resposta.statusCode, resposta.body).toBe(200)
    expect(resposta.json().differenceCents).toBe(0)
    expect(resposta.json().byMethod).toContainEqual({
      method: 'PIX_MANUAL',
      expectedCents: 25_000,
      countedCents: null,
    })
  })

  it('a recepção opera o caixa; quem dá banho não vê', async () => {
    const recepcao = await asRole(fixture, 'RECEPTIONIST')
    await abrir(0, recepcao)

    const banhista = await asRole(fixture, 'BATHER')
    const resposta = await callApi({ ...banhista, method: 'GET', url: '/v1/cash/current' })
    expect(resposta.statusCode).toBe(403)
    expect(resposta.json().code).toBe('ERR_CASH_007')
  })

  it('o Starter recebe 402', async () => {
    const starter = await givenTenant('STARTER')
    const resposta = await callApi({
      ...asAdmin(starter),
      method: 'GET',
      url: '/v1/cash/current',
    })
    expect(resposta.statusCode).toBe(402)
  })
})

// ─── A venda avulsa ──────────────────────────────────────────────────────────

describe('a venda avulsa', () => {
  it('sem caixa aberto não acontece, e o estoque não sai', async () => {
    const produto = await racao('5')

    const resposta = await vender({
      items: [{ productId: produto, quantity: '1' }],
      paymentMethod: 'CASH',
    })

    expect(resposta.statusCode).toBe(409)
    expect(resposta.json().code).toBe('ERR_CASH_004')
    const lote = await ownerPrisma.stockLot.findFirstOrThrow({ where: { productId: produto } })
    expect(lote.quantityOnHand.toString()).toBe('5')
  })

  it('pede a forma de pagamento', async () => {
    await abrir()
    const produto = await racao()
    const resposta = await vender({ items: [{ productId: produto, quantity: '1' }] })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_002')
  })

  it('entra no caixa aberto pela forma escolhida', async () => {
    await abrir(10_000)
    const produto = await racao()

    const resposta = await vender({
      items: [{ productId: produto, quantity: '2' }],
      paymentMethod: 'PIX_MANUAL',
    })

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(resposta.json().sale.paymentMethod).toBe('PIX_MANUAL')
    const sessao = (await atual())!
    expect(esperado(sessao, 'PIX_MANUAL')).toBe(50_000)
    expect(esperado(sessao, 'CASH')).toBe(10_000)
    expect(sessao.receivedCents).toBe(50_000)
    expect(sessao.movements[0]).toMatchObject({
      type: 'WALK_IN_SALE',
      description: 'Venda Avulsa · Ração 15 kg ×2',
    })
  })

  it('o estorno devolve pelo caixa aberto, e sem caixa não devolve', async () => {
    const sessao = await abrir(10_000)
    const produto = await racao()
    const venda = (
      await vender({ items: [{ productId: produto, quantity: '1' }], paymentMethod: 'CASH' })
    ).json().sale
    await fechar(sessao.id, { counts: [{ method: 'CASH', countedCents: 35_000 }] })

    const url = `/v1/inventory/sales/${venda.id}/reverse`
    const semCaixa = await callApi({ ...admin, method: 'POST', url, payload: { reason: 'Troca' } })
    expect(semCaixa.statusCode).toBe(409)
    expect(semCaixa.json().code).toBe('ERR_CASH_004')

    await abrir(10_000)
    const estorno = await callApi({ ...admin, method: 'POST', url, payload: { reason: 'Troca' } })
    expect(estorno.statusCode, estorno.body).toBe(200)
    const hoje = (await atual())!
    // O dinheiro sai da gaveta de hoje, e não da de ontem, que já foi contada.
    expect(esperado(hoje)).toBe(10_000 - 25_000)
    expect(hoje.movements[0]).toMatchObject({ type: 'SALE_REFUND', amountCents: -25_000 })
  })
})

// ─── O pagamento do tutor ────────────────────────────────────────────────────

describe('o pagamento do tutor', () => {
  it('"pago agora" quita a própria venda, e não a dívida mais antiga', async () => {
    await abrir(0)
    const produto = await racao()
    const tutorId = await givenTutor(fixture)
    await vender({ tutorId, items: [{ productId: produto, quantity: '1' }] })
    expect(await balanceOf(tutorId)).toBe(-25_000)

    const resposta = await vender({
      tutorId,
      items: [{ productId: produto, quantity: '2' }],
      paymentMethod: 'CARD_MACHINE_DEBIT',
    })

    expect(resposta.statusCode, resposta.body).toBe(201)
    // A dívida antiga continua; a venda de agora está paga.
    expect(await balanceOf(tutorId)).toBe(-25_000)
    const venda = await ownerPrisma.productSale.findUniqueOrThrow({
      where: { id: resposta.json().sale.id },
    })
    expect(venda.paymentId).not.toBeNull()
    const debito = await ownerPrisma.ledgerEntry.findUniqueOrThrow({
      where: { id: venda.ledgerEntryId! },
    })
    expect(debito.settledCents).toBe(debito.amountCents)
    expect(esperado((await atual())!, 'CARD_MACHINE_DEBIT')).toBe(50_000)
  })

  it('"pago agora" sem caixa aberto registra o pagamento do mesmo jeito', async () => {
    const produto = await racao()
    const tutorId = await givenTutor(fixture)

    const resposta = await vender({
      tutorId,
      items: [{ productId: produto, quantity: '1' }],
      paymentMethod: 'CASH',
    })

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(await balanceOf(tutorId)).toBe(0)
    expect(await ownerPrisma.cashMovement.count()).toBe(0)
  })

  it('o pagamento do Financeiro entra no caixa aberto, e o estorno sai dele', async () => {
    await abrir(0)
    const tutorId = await givenTutor(fixture)

    const pagamento = await pagar(tutorId, 8_000)
    expect(pagamento.statusCode, pagamento.body).toBe(201)
    let sessao = (await atual())!
    expect(esperado(sessao)).toBe(8_000)
    expect(sessao.movements[0]).toMatchObject({
      type: 'TUTOR_PAYMENT',
      description: 'Pagamento de Tutor · Maria Silva',
    })

    const estorno = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/payments/${pagamento.json().id}/reverse`,
      payload: { reason: 'Tutor errado' },
    })
    expect(estorno.statusCode, estorno.body).toBe(200)
    sessao = (await atual())!
    expect(esperado(sessao)).toBe(0)
  })

  it('o pagamento com data anterior à abertura não entra no caixa', async () => {
    await abrir(0)
    const tutorId = await givenTutor(fixture)

    const ontem = new Date(Date.now() - 86_400_000).toISOString()
    const resposta = await pagar(tutorId, 8_000, { method: 'PIX_MANUAL', receivedAt: ontem })

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(esperado((await atual())!, 'PIX_MANUAL')).toBe(0)
  })

  it('sem caixa aberto, o pagamento é registrado e o caixa não é tocado', async () => {
    const tutorId = await givenTutor(fixture)
    const resposta = await pagar(tutorId, 8_000)
    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(await ownerPrisma.cashMovement.count()).toBe(0)
  })
})

// ─── Os relatórios do financeiro ─────────────────────────────────────────────

describe('os relatórios somam a venda avulsa', () => {
  it('"Recebido hoje" e "Contas recebidas" contam a avulsa à parte', async () => {
    await abrir(0)
    const produto = await racao()
    const tutorId = await givenTutor(fixture)
    await pagar(tutorId, 8_000)
    await vender({ items: [{ productId: produto, quantity: '1' }], paymentMethod: 'PIX_MANUAL' })

    const fluxo = await callApi({ ...admin, method: 'GET', url: '/v1/ledger/reports/cashflow' })
    expect(fluxo.statusCode, fluxo.body).toBe(200)
    expect(fluxo.json()).toMatchObject({
      totalCents: 33_000,
      paymentsCount: 1,
      walkInCents: 25_000,
      walkInCount: 1,
    })

    const porDia = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/ledger/reports/receipts-by-day',
    })
    expect(porDia.statusCode, porDia.body).toBe(200)
    const relatorio = porDia.json()
    expect(relatorio.totalCents).toBe(33_000)
    expect(relatorio.walkIn).toEqual({
      totalCents: 25_000,
      count: 1,
      byMethod: [{ method: 'PIX_MANUAL', totalCents: 25_000, count: 1 }],
    })
    expect(relatorio.days).toHaveLength(1)
    expect(relatorio.days[0]).toMatchObject({
      totalCents: 33_000,
      count: 1,
      walkInCents: 25_000,
      walkInCount: 1,
    })
  })

  it('a venda estornada não conta', async () => {
    await abrir(0)
    const produto = await racao()
    const venda = (
      await vender({ items: [{ productId: produto, quantity: '1' }], paymentMethod: 'CASH' })
    ).json().sale
    await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/inventory/sales/${venda.id}/reverse`,
      payload: { reason: 'Troca' },
    })

    const fluxo = await callApi({ ...admin, method: 'GET', url: '/v1/ledger/reports/cashflow' })
    expect(fluxo.json()).toMatchObject({ totalCents: 0, walkInCount: 0 })
  })
})
