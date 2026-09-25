import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  callApi,
  chave,
  closeHarness,
  emDias,
  givenAttendance,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type AttendanceFixture,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-ESTOQUE, fatia 3: o consumo no atendimento, o uso interno e o rastreio de lote.
 *
 * O contrato é o da RN-07/08: a lista de produtos do atendimento **é** a baixa, feita
 * pela diferença e na mesma transação; anular devolve; e o atendimento nunca trava por
 * falta de estoque (RN-06).
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

async function vacina(corpo: Record<string, unknown> = {}): Promise<string> {
  const resposta = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/products',
    payload: { name: 'Vacina V10', kind: 'SUPPLY', tracksExpiry: true, ...corpo },
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

async function saldo(lotId: string): Promise<string> {
  return (
    await ownerPrisma.stockLot.findUniqueOrThrow({ where: { id: lotId } })
  ).quantityOnHand.toString()
}

async function usar(
  atendimento: AttendanceFixture,
  productsUsed: Record<string, unknown>[],
  caller: Caller = admin,
) {
  return callApi({
    ...caller,
    method: 'PATCH',
    url: `/v1/attendances/${atendimento.attendanceId}`,
    payload: { items: [{ id: atendimento.itemId, productsUsed }] },
  })
}

// ─── Consumo no atendimento (MOD-ESTOQUE-07) ─────────────────────────────────

describe('o produto usado no atendimento', () => {
  it('dá baixa no lote e o prontuário guarda o retrato com o lote', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '10', { batchCode: 'L2410B', expiresAt: emDias(200) })
    const atendimento = await givenAttendance(fixture)

    const resposta = await usar(atendimento, [
      { name: 'qualquer', productId: produto, lotId: lote, quantity: '1' },
    ])

    expect(resposta.statusCode, resposta.body).toBe(200)
    // O nome e o lote saem do cadastro, e não do que a tela mandou.
    expect(resposta.json().items[0].productsUsed).toEqual([
      { name: 'Vacina V10', batch: 'L2410B', productId: produto, lotId: lote, quantity: '1' },
    ])
    expect(await saldo(lote)).toBe('9')

    const movimento = await ownerPrisma.stockMovement.findFirstOrThrow({
      where: { lotId: lote, type: 'CONSUMPTION_OUT' },
    })
    expect(movimento).toMatchObject({
      sourceType: 'ATTENDANCE_ITEM',
      sourceId: atendimento.itemId,
      petId: atendimento.petId,
      tutorId: atendimento.tutorId,
    })
  })

  it('a edição grava só a diferença (AC-02)', async () => {
    const produto = await vacina({ name: 'Shampoo', tracksExpiry: false, unit: 'ML' })
    const lote = await entrada(produto, '500')
    const atendimento = await givenAttendance(fixture)

    await usar(atendimento, [{ name: 'x', productId: produto, lotId: lote, quantity: '60' }])
    await usar(atendimento, [{ name: 'x', productId: produto, lotId: lote, quantity: '40' }])

    expect(await saldo(lote)).toBe('460')
    const tipos = (
      await ownerPrisma.stockMovement.findMany({
        where: { lotId: lote, sourceType: 'ATTENDANCE_ITEM' },
        orderBy: { postedAt: 'asc' },
      })
    ).map((movimento) => [movimento.type, movimento.quantity.toString()])
    expect(tipos).toEqual([
      ['CONSUMPTION_OUT', '-60'],
      ['RETURN_IN', '20'],
    ])
  })

  it('repetir a mesma edição não grava nada', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '5', { batchCode: 'A1', expiresAt: emDias(200) })
    const atendimento = await givenAttendance(fixture)
    const lista = [{ name: 'x', productId: produto, lotId: lote, quantity: '1' }]

    await usar(atendimento, lista)
    await usar(atendimento, lista)

    expect(await saldo(lote)).toBe('4')
    expect(
      await ownerPrisma.stockMovement.count({ where: { sourceType: 'ATTENDANCE_ITEM' } }),
    ).toBe(1)
  })

  it('tirar o produto da lista devolve ao lote', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '5', { batchCode: 'A1', expiresAt: emDias(200) })
    const atendimento = await givenAttendance(fixture)

    await usar(atendimento, [{ name: 'x', productId: produto, lotId: lote, quantity: '2' }])
    await usar(atendimento, [])
    expect(await saldo(lote)).toBe('5')
  })

  it('sem saldo, grava assim mesmo e o lote fica negativo (RN-06)', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '1', { batchCode: 'A1', expiresAt: emDias(200) })
    const atendimento = await givenAttendance(fixture)

    const resposta = await usar(atendimento, [
      { name: 'x', productId: produto, lotId: lote, quantity: '3' },
    ])
    expect(resposta.statusCode).toBe(200)
    expect(await saldo(lote)).toBe('-2')
  })

  it('vacina vencida na data do atendimento é recusada (AC-06)', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '5', { batchCode: 'VELHO', expiresAt: emDias(-10) })
    const atendimento = await givenAttendance(fixture)

    const resposta = await usar(atendimento, [
      { name: 'x', productId: produto, lotId: lote, quantity: '1' },
    ])
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_011')
    expect(await saldo(lote)).toBe('5')
  })

  it('a linha só de texto continua valendo e não mexe em estoque', async () => {
    const atendimento = await givenAttendance(fixture)
    const resposta = await usar(atendimento, [{ name: 'Shampoo da casa', batch: 'XYZ' }])
    expect(resposta.statusCode).toBe(200)
    expect(resposta.json().items[0].productsUsed).toEqual([
      { name: 'Shampoo da casa', batch: 'XYZ' },
    ])
    expect(await ownerPrisma.stockMovement.count()).toBe(0)
  })

  it('produto de venda não é insumo', async () => {
    const racao = await vacina({
      name: 'Ração',
      kind: 'RETAIL',
      salePriceCents: 1000,
      tracksExpiry: false,
    })
    const lote = await entrada(racao, '5')
    const atendimento = await givenAttendance(fixture)
    const resposta = await usar(atendimento, [
      { name: 'x', productId: racao, lotId: lote, quantity: '1' },
    ])
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_008')
  })

  it('sem o plano, a ligação com o estoque sai e a linha fica como texto (AC-05)', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '5', { batchCode: 'A1', expiresAt: emDias(200) })
    const atendimento = await givenAttendance(fixture)
    await ownerPrisma.tenant.update({ where: { id: fixture.tenantId }, data: { plan: 'STARTER' } })

    const resposta = await usar(atendimento, [
      { name: 'Vacina V10', batch: 'A1', productId: produto, lotId: lote, quantity: '1' },
    ])
    expect(resposta.statusCode).toBe(200)
    expect(resposta.json().items[0].productsUsed).toEqual([{ name: 'Vacina V10', batch: 'A1' }])
    expect(await saldo(lote)).toBe('5')
  })

  it('anular o atendimento devolve tudo (AC-04)', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '5', { batchCode: 'A1', expiresAt: emDias(200) })
    const atendimento = await givenAttendance(fixture)
    await usar(atendimento, [{ name: 'x', productId: produto, lotId: lote, quantity: '2' }])

    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/attendances/${atendimento.attendanceId}/void`,
      payload: { reason: 'Registrado no pet errado' },
    })
    expect(resposta.statusCode, resposta.body).toBe(200)
    expect(await saldo(lote)).toBe('5')
    const devolucao = await ownerPrisma.stockMovement.findFirstOrThrow({
      where: { type: 'VOID_RETURN' },
    })
    expect(devolucao.quantity.toString()).toBe('2')
  })
})

// ─── Uso interno (MOD-ESTOQUE-08) ────────────────────────────────────────────

describe('o uso interno', () => {
  async function shampoo() {
    return vacina({ name: 'Shampoo neutro', unit: 'ML', tracksExpiry: false })
  }

  it('quem dá banho registra, por FEFO', async () => {
    const produto = await shampoo()
    const tarde = await entrada(produto, '500', { batchCode: 'TARDE', expiresAt: emDias(300) })
    const cedo = await entrada(produto, '100', { batchCode: 'CEDO', expiresAt: emDias(40) })
    const banhista = await asRole(fixture, 'BATHER')

    const resposta = await callApi({
      ...banhista,
      method: 'POST',
      url: '/v1/inventory/internal-use',
      payload: { productId: produto, quantity: '150', idempotencyKey: chave() },
    })
    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(await saldo(cedo)).toBe('0')
    expect(await saldo(tarde)).toBe('450')
  })

  it('o que falta sai negativo em vez de ser recusado', async () => {
    const produto = await shampoo()
    const lote = await entrada(produto, '50', { batchCode: 'A1' })
    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/internal-use',
      payload: { productId: produto, quantity: '80', idempotencyKey: chave() },
    })
    expect(resposta.statusCode).toBe(201)
    expect(await saldo(lote)).toBe('-30')
  })

  it('produto sem entrada nenhuma nasce negativo no lote implícito', async () => {
    const produto = await shampoo()
    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/internal-use',
      payload: { productId: produto, quantity: '20', idempotencyKey: chave() },
    })
    expect(resposta.statusCode).toBe(201)
    expect(resposta.json().lot).toMatchObject({ batchCode: 'SEM-LOTE', quantityOnHand: '-20' })
  })

  it('a recepção não registra uso interno', async () => {
    const produto = await shampoo()
    const recepcao = await asRole(fixture, 'RECEPTIONIST')
    const resposta = await callApi({
      ...recepcao,
      method: 'POST',
      url: '/v1/inventory/internal-use',
      payload: { productId: produto, quantity: '1', idempotencyKey: chave() },
    })
    expect(resposta.statusCode).toBe(403)
  })

  it('o duplo clique grava uma vez', async () => {
    const produto = await shampoo()
    const lote = await entrada(produto, '100', { batchCode: 'A1' })
    const corpo = { productId: produto, quantity: '10', idempotencyKey: chave() }
    const respostas = await Promise.all(
      Array.from({ length: 3 }, () =>
        callApi({ ...admin, method: 'POST', url: '/v1/inventory/internal-use', payload: corpo }),
      ),
    )
    expect(respostas.every((resposta) => [200, 201].includes(resposta.statusCode))).toBe(true)
    expect(await saldo(lote)).toBe('90')
  })
})

// ─── Rastreio de lote (MOD-ESTOQUE-10) ───────────────────────────────────────

describe('quem recebeu o lote', () => {
  it('lista os pets que receberam, e a anulação aparece como devolução', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '10', { batchCode: 'L1', expiresAt: emDias(200) })
    const primeiro = await givenAttendance(fixture)
    const segundo = await givenAttendance(fixture)
    await usar(primeiro, [{ name: 'x', productId: produto, lotId: lote, quantity: '1' }])
    await usar(segundo, [{ name: 'x', productId: produto, lotId: lote, quantity: '1' }])

    await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/attendances/${segundo.attendanceId}/void`,
      payload: { reason: 'Registrado no pet errado' },
    })

    const resposta = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/inventory/lots/${lote}/trace`,
    })
    expect(resposta.statusCode, resposta.body).toBe(200)
    const { entries, productName } = resposta.json()
    expect(productName).toBe('Vacina V10')
    expect(
      entries.map((entry: { type: string; quantity: string }) => [entry.type, entry.quantity]),
    ).toEqual([
      ['VOID_RETURN', '-1'],
      ['CONSUMPTION_OUT', '1'],
      ['CONSUMPTION_OUT', '1'],
    ])
    expect(entries[1]).toMatchObject({ petName: 'Thor', tutorName: 'Ana Souza' })
  })

  it('quem dá banho não lê o rastreio: é prontuário pelo avesso', async () => {
    const produto = await vacina()
    const lote = await entrada(produto, '1', { batchCode: 'L1', expiresAt: emDias(200) })
    const banhista = await asRole(fixture, 'BATHER')
    const resposta = await callApi({
      ...banhista,
      method: 'GET',
      url: `/v1/inventory/lots/${lote}/trace`,
    })
    expect(resposta.statusCode).toBe(403)
  })
})
