import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  balanceOf,
  callApi,
  chave,
  closeHarness,
  emDias,
  givenCreditLimit,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-ESTOQUE, fatia 2: a venda no balcão e o estorno.
 *
 * O contrato que estes testes seguram é o da RN-11: **a baixa e o débito vingam juntos
 * ou não vingam**. Toda venda confere os dois lados — o lote e a conta do tutor.
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

async function produto(corpo: Record<string, unknown> = {}): Promise<string> {
  const resposta = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/products',
    payload: { name: 'Ração 15 kg', kind: 'RETAIL', salePriceCents: 25_000, ...corpo },
  })
  expect(resposta.statusCode, resposta.body).toBe(201)
  return resposta.json().id as string
}

async function entrada(productId: string, quantity: string, extra: Record<string, unknown> = {}) {
  const resposta = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/entries',
    payload: { productId, quantity, idempotencyKey: chave(), ...extra },
  })
  expect(resposta.statusCode, resposta.body).toBe(201)
  return resposta.json().lot.id as string
}

async function vender(corpo: Record<string, unknown>, caller: Caller = admin) {
  return callApi({
    ...caller,
    method: 'POST',
    url: '/v1/inventory/sales',
    payload: { idempotencyKey: chave(), ...corpo },
  })
}

async function saldoDoLote(lotId: string): Promise<string> {
  const lote = await ownerPrisma.stockLot.findUniqueOrThrow({ where: { id: lotId } })
  return lote.quantityOnHand.toString()
}

// ─── A venda (MOD-ESTOQUE-05) ────────────────────────────────────────────────

describe('a venda com tutor', () => {
  it('dá baixa e lança o débito PRODUCT, na mesma venda', async () => {
    const racao = await produto()
    const coleira = await produto({ name: 'Coleira M', salePriceCents: 3_990 })
    const loteRacao = await entrada(racao, '5')
    const loteColeira = await entrada(coleira, '10')
    const tutorId = await givenTutor(fixture)

    const resposta = await vender({
      tutorId,
      items: [
        { productId: racao, quantity: '1' },
        { productId: coleira, quantity: '2' },
      ],
    })

    expect(resposta.statusCode, resposta.body).toBe(201)
    const { sale } = resposta.json()
    expect(sale).toMatchObject({
      totalCents: 32_980,
      status: 'COMPLETED',
      tutorName: 'Maria Silva',
    })
    expect(sale.ledgerEntryId).not.toBeNull()

    expect(await saldoDoLote(loteRacao)).toBe('4')
    expect(await saldoDoLote(loteColeira)).toBe('8')
    expect(await balanceOf(tutorId)).toBe(-32_980)

    const lancamento = await ownerPrisma.ledgerEntry.findUniqueOrThrow({
      where: { id: sale.ledgerEntryId },
    })
    expect(lancamento).toMatchObject({
      category: 'PRODUCT',
      direction: 'DEBIT',
      sourceType: 'PRODUCT_SALE',
      sourceId: sale.id,
      description: 'Venda: Ração 15 kg, Coleira M ×2',
    })
  })

  it('a venda avulsa dá baixa e não toca o razão (RN-12)', async () => {
    const racao = await produto()
    const lote = await entrada(racao, '3')

    const resposta = await vender({ items: [{ productId: racao, quantity: '1' }] })
    expect(resposta.statusCode).toBe(201)
    expect(resposta.json().sale).toMatchObject({
      tutorId: null,
      ledgerEntryId: null,
      totalCents: 25_000,
    })
    expect(await saldoDoLote(lote)).toBe('2')
    expect(await ownerPrisma.ledgerEntry.count()).toBe(0)
  })

  it('o preço fracionado arredonda para o centavo', async () => {
    const granel = await produto({ name: 'Ração a granel', unit: 'KG', salePriceCents: 3_290 })
    await entrada(granel, '10')
    const resposta = await vender({ items: [{ productId: granel, quantity: '0,375' }] })
    // 0,375 × 32,90 = 12,3375 → R$ 12,34
    expect(resposta.json().sale.totalCents).toBe(1_234)
  })

  it('o preço e o nome ficam congelados na venda (RN-10)', async () => {
    const racao = await produto()
    await entrada(racao, '3')
    const venda = (await vender({ items: [{ productId: racao, quantity: '1' }] })).json().sale

    await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${racao}`,
      payload: { name: 'Ração Nova', salePriceCents: 99_000 },
    })
    const lida = await callApi({ ...admin, method: 'GET', url: `/v1/inventory/sales/${venda.id}` })
    expect(lida.json().items[0]).toMatchObject({ label: 'Ração 15 kg', unitPriceCents: 25_000 })
  })

  it('insumo não se vende', async () => {
    const shampoo = await produto({ name: 'Shampoo', kind: 'SUPPLY', salePriceCents: null })
    await entrada(shampoo, '5')
    const resposta = await vender({ items: [{ productId: shampoo, quantity: '1' }] })
    expect(resposta.statusCode).toBe(422)
  })
})

describe('o saldo que não basta (AC-02)', () => {
  it('recusa a venda inteira e diz quanto há de cada produto', async () => {
    const racao = await produto()
    const coleira = await produto({ name: 'Coleira M', salePriceCents: 3_990 })
    const loteRacao = await entrada(racao, '5')
    await entrada(coleira, '1')

    const resposta = await vender({
      items: [
        { productId: racao, quantity: '2' },
        { productId: coleira, quantity: '3' },
      ],
    })

    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_010')
    expect(resposta.json().items).toEqual([
      { productId: coleira, name: 'Coleira M', requested: '3', available: '1' },
    ])
    // Nada saiu: nem a ração, que tinha.
    expect(await saldoDoLote(loteRacao)).toBe('5')
    expect(await ownerPrisma.productSale.count()).toBe(0)
  })

  it('duas vendas simultâneas da última unidade: uma passa (RN-05)', async () => {
    const racao = await produto()
    const lote = await entrada(racao, '1')

    const respostas = await Promise.all([
      vender({ items: [{ productId: racao, quantity: '1' }] }),
      vender({ items: [{ productId: racao, quantity: '1' }] }),
    ])
    expect(respostas.map((resposta) => resposta.statusCode).sort()).toEqual([201, 422])
    expect(await saldoDoLote(lote)).toBe('0')
  })

  it('lote vencido não conta como saldo', async () => {
    const vermifugo = await produto({ name: 'Vermífugo', tracksExpiry: true })
    await entrada(vermifugo, '5', { batchCode: 'VELHO', expiresAt: emDias(-3) })

    const resposta = await vender({ items: [{ productId: vermifugo, quantity: '1' }] })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().items[0].available).toBe('0')

    const lote = (await ownerPrisma.stockLot.findFirstOrThrow({ where: { productId: vermifugo } }))
      .id
    const escolhido = await vender({
      items: [{ productId: vermifugo, quantity: '1', lotId: lote }],
    })
    expect(escolhido.statusCode).toBe(422)
    expect(escolhido.json().code).toBe('ERR_INV_011')
  })
})

describe('FEFO (RN-04)', () => {
  it('sai o que vence primeiro, atravessando lotes', async () => {
    const vermifugo = await produto({ name: 'Vermífugo', tracksExpiry: true })
    const tarde = await entrada(vermifugo, '5', { batchCode: 'TARDE', expiresAt: emDias(300) })
    const cedo = await entrada(vermifugo, '2', { batchCode: 'CEDO', expiresAt: emDias(40) })

    const resposta = await vender({ items: [{ productId: vermifugo, quantity: '3' }] })
    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(await saldoDoLote(cedo)).toBe('0')
    expect(await saldoDoLote(tarde)).toBe('4')
  })

  it('o lote escolhido prevalece sobre o FEFO', async () => {
    const vermifugo = await produto({ name: 'Vermífugo', tracksExpiry: true })
    const tarde = await entrada(vermifugo, '5', { batchCode: 'TARDE', expiresAt: emDias(300) })
    const cedo = await entrada(vermifugo, '2', { batchCode: 'CEDO', expiresAt: emDias(40) })

    await vender({ items: [{ productId: vermifugo, quantity: '1', lotId: tarde }] })
    expect(await saldoDoLote(tarde)).toBe('4')
    expect(await saldoDoLote(cedo)).toBe('2')
  })
})

describe('o limite de crédito (AC-06)', () => {
  async function tutorDevendo(dividaCents: number) {
    const tutorId = await givenTutor(fixture)
    const racao = await produto({ salePriceCents: dividaCents })
    await entrada(racao, '10')
    await vender({ tutorId, items: [{ productId: racao, quantity: '1' }] })
    return { tutorId, racao }
  }

  it('acima do limite a venda para e pede liberação', async () => {
    const { tutorId, racao } = await tutorDevendo(30_000)
    await givenCreditLimit(fixture, 20_000)

    const resposta = await vender({ tutorId, items: [{ productId: racao, quantity: '1' }] })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json()).toMatchObject({ code: 'ERR_INV_015', requiresOverride: true })
  })

  it('a recepção não libera; o administrador libera com motivo', async () => {
    const { tutorId, racao } = await tutorDevendo(30_000)
    await givenCreditLimit(fixture, 20_000)
    const recepcao = await asRole(fixture, 'RECEPTIONIST')

    const negada = await vender(
      {
        tutorId,
        items: [{ productId: racao, quantity: '1' }],
        creditOverrideReason: 'Cliente antigo',
      },
      recepcao,
    )
    expect(negada.statusCode).toBe(403)

    const liberada = await vender({
      tutorId,
      items: [{ productId: racao, quantity: '1' }],
      creditOverrideReason: 'Cliente antigo, paga no dia 10',
    })
    expect(liberada.statusCode).toBe(201)
    expect(await balanceOf(tutorId)).toBe(-60_000)
  })

  it('a venda avulsa não passa pelo limite', async () => {
    await givenCreditLimit(fixture, 0)
    const racao = await produto()
    await entrada(racao, '2')
    expect((await vender({ items: [{ productId: racao, quantity: '1' }] })).statusCode).toBe(201)
  })
})

describe('o duplo clique', () => {
  it('a mesma chave com o mesmo carrinho devolve a mesma venda', async () => {
    const racao = await produto()
    const lote = await entrada(racao, '5')
    const tutorId = await givenTutor(fixture)
    const corpo = { tutorId, items: [{ productId: racao, quantity: '1' }], idempotencyKey: chave() }

    const respostas = await Promise.all(Array.from({ length: 3 }, () => vender(corpo)))
    expect(respostas.every((resposta) => [200, 201].includes(resposta.statusCode))).toBe(true)
    expect(await ownerPrisma.productSale.count()).toBe(1)
    expect(await saldoDoLote(lote)).toBe('4')
    expect(await balanceOf(tutorId)).toBe(-25_000)
  })

  it('a mesma chave com outro carrinho é recusada', async () => {
    const racao = await produto()
    await entrada(racao, '5')
    const idempotencyKey = chave()
    await vender({ items: [{ productId: racao, quantity: '1' }], idempotencyKey })
    const outra = await vender({ items: [{ productId: racao, quantity: '2' }], idempotencyKey })
    expect(outra.statusCode).toBe(409)
    expect(outra.json().code).toBe('ERR_INV_013')
  })
})

// ─── O estorno (MOD-ESTOQUE-06) ──────────────────────────────────────────────

describe('o estorno', () => {
  it('devolve ao lote de origem e estorna o débito', async () => {
    const vermifugo = await produto({ name: 'Vermífugo', tracksExpiry: true })
    const tarde = await entrada(vermifugo, '5', { batchCode: 'TARDE', expiresAt: emDias(300) })
    const cedo = await entrada(vermifugo, '1', { batchCode: 'CEDO', expiresAt: emDias(40) })
    const tutorId = await givenTutor(fixture)

    const venda = (
      await vender({ tutorId, items: [{ productId: vermifugo, quantity: '3' }] })
    ).json().sale
    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/inventory/sales/${venda.id}/reverse`,
      payload: { reason: 'Cliente devolveu fechado' },
    })

    expect(resposta.statusCode, resposta.body).toBe(200)
    expect(resposta.json()).toMatchObject({
      status: 'REVERSED',
      reversalReason: 'Cliente devolveu fechado',
    })
    // RN-13: cada lote recebe de volta o que saiu dele — não o que o FEFO escolheria hoje.
    expect(await saldoDoLote(cedo)).toBe('1')
    expect(await saldoDoLote(tarde)).toBe('5')
    expect(await balanceOf(tutorId)).toBe(0)

    const original = await ownerPrisma.ledgerEntry.findUniqueOrThrow({
      where: { id: venda.ledgerEntryId },
    })
    expect(original.status).toBe('REVERSED')
  })

  it('não estorna duas vezes', async () => {
    const racao = await produto()
    await entrada(racao, '5')
    const venda = (await vender({ items: [{ productId: racao, quantity: '1' }] })).json().sale
    const url = `/v1/inventory/sales/${venda.id}/reverse`

    await callApi({ ...admin, method: 'POST', url, payload: { reason: 'Engano' } })
    const segunda = await callApi({ ...admin, method: 'POST', url, payload: { reason: 'Engano' } })
    expect(segunda.statusCode).toBe(409)
    expect(segunda.json().code).toBe('ERR_INV_012')
  })

  it('débito já estornado pelo financeiro: a venda só devolve ao estoque', async () => {
    const racao = await produto()
    const lote = await entrada(racao, '5')
    const tutorId = await givenTutor(fixture)
    const venda = (await vender({ tutorId, items: [{ productId: racao, quantity: '1' }] })).json()
      .sale

    const pelaTelaDoFinanceiro = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/ledger/entries/${venda.ledgerEntryId}/reverse`,
      payload: { reason: 'Estornado no financeiro' },
    })
    expect(pelaTelaDoFinanceiro.statusCode, pelaTelaDoFinanceiro.body).toBeLessThan(300)

    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/inventory/sales/${venda.id}/reverse`,
      payload: { reason: 'Devolvido' },
    })
    expect(resposta.statusCode).toBe(200)
    expect(await saldoDoLote(lote)).toBe('5')
    expect(await balanceOf(tutorId)).toBe(0)
  })

  it('a recepção vende mas não estorna', async () => {
    const racao = await produto()
    await entrada(racao, '5')
    const recepcao = await asRole(fixture, 'RECEPTIONIST')
    const venda = await vender({ items: [{ productId: racao, quantity: '1' }] }, recepcao)
    expect(venda.statusCode).toBe(201)

    const estorno = await callApi({
      ...recepcao,
      method: 'POST',
      url: `/v1/inventory/sales/${venda.json().sale.id}/reverse`,
      payload: { reason: 'Engano' },
    })
    expect(estorno.statusCode).toBe(403)
  })

  it('quem dá banho não vende', async () => {
    const racao = await produto()
    await entrada(racao, '5')
    const banhista = await asRole(fixture, 'BATHER')
    expect(
      (await vender({ items: [{ productId: racao, quantity: '1' }] }, banhista)).statusCode,
    ).toBe(403)
  })
})

describe('a lista de vendas', () => {
  it('filtra pelo tutor e pagina da mais nova para a mais velha', async () => {
    const racao = await produto()
    await entrada(racao, '10')
    const maria = await givenTutor(fixture, 'Maria')
    const joao = await givenTutor(fixture, 'João')
    await vender({ tutorId: maria, items: [{ productId: racao, quantity: '1' }] })
    await vender({ tutorId: joao, items: [{ productId: racao, quantity: '2' }] })
    await vender({ tutorId: maria, items: [{ productId: racao, quantity: '3' }] })

    const daMaria = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/inventory/sales?tutorId=${maria}&limit=1`,
    })
    const pagina = daMaria.json()
    expect(pagina.items[0].items[0].quantity).toBe('3')
    expect(pagina.nextCursor).not.toBeNull()

    const resto = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/inventory/sales?tutorId=${maria}&limit=1&cursor=${pagina.nextCursor}`,
    })
    expect(resto.json().items[0].items[0].quantity).toBe('1')
    expect(resto.json().nextCursor).toBeNull()
  })
})
