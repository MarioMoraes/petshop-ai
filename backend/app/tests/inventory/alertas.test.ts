import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InventoryPositionReport } from '@petshop/shared-types'
import { PdfUnavailableError, setPdfPort } from '../../src/modules/inventory/pdf-port.js'
import { renderPositionHtml } from '../../src/modules/inventory/position-template.js'
import { reconcileStock } from '../../src/modules/inventory/reconciliation.js'
import {
  asAdmin,
  asRole,
  callApi,
  chave,
  closeHarness,
  emDias,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-ESTOQUE, fatia 4: os alertas do sino, a janela de validade, a posição valorizada e
 * a reconciliação.
 *
 * O contrato que mais importa é o do AC-03 de MOD-ESTOQUE-09: o alerta é **leitura de
 * estado**, e o número do sino é o tamanho da lista para onde ele aponta.
 */

let fixture: TenantFixture
let admin: Caller

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  admin = asAdmin(fixture)
})

afterEach(() => setPdfPort(null))

afterAll(closeHarness)

// ─── Ajudantes ───────────────────────────────────────────────────────────────

async function produto(corpo: Record<string, unknown> = {}, caller: Caller = admin) {
  const resposta = await callApi({
    ...caller,
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

async function alertas(caller: Caller = admin) {
  const resposta = await callApi({ ...caller, method: 'GET', url: '/v1/inventory/alerts' })
  expect(resposta.statusCode, resposta.body).toBe(200)
  return resposta.json() as {
    expiringLots: number
    lowProducts: number
    negativeProducts: number
    expiryWarningDays: number
  }
}

async function posicao(query = ''): Promise<InventoryPositionReport> {
  const resposta = await callApi({
    ...admin,
    method: 'GET',
    url: `/v1/inventory/reports/position${query}`,
  })
  expect(resposta.statusCode, resposta.body).toBe(200)
  return resposta.json() as InventoryPositionReport
}

// ─── Alertas (MOD-ESTOQUE-09) ────────────────────────────────────────────────

describe('alertas do sino', () => {
  it('estoque vazio não tem alerta, e a janela é a padrão', async () => {
    expect(await alertas()).toEqual({
      expiringLots: 0,
      lowProducts: 0,
      negativeProducts: 0,
      expiryWarningDays: 30,
    })
  })

  it('AC-01: conta lote vencendo e vencido com saldo, e ignora o de longe e o zerado', async () => {
    const id = await produto()
    await entrada(id, '5', { batchCode: 'PERTO', expiresAt: emDias(10) })
    await entrada(id, '5', { batchCode: 'LONGE', expiresAt: emDias(90) })
    // Vencido e ainda na prateleira: é o alerta mais urgente de todos.
    await entrada(id, '2', { batchCode: 'VENCIDO', expiresAt: emDias(-3) })
    const zerado = await entrada(id, '1', { batchCode: 'ZERADO', expiresAt: emDias(5) })
    await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/adjustments',
      payload: {
        lotId: zerado,
        mode: 'COUNT',
        quantity: '0',
        type: 'LOSS',
        reason: 'Frasco quebrado',
        idempotencyKey: chave(),
      },
    })

    expect((await alertas()).expiringLots).toBe(2)
  })

  it('AC-02: conta produto abaixo do mínimo, e mínimo zero não é alerta', async () => {
    await produto({ name: 'Shampoo', tracksExpiry: false, unit: 'ML', minQuantity: '1000' })
    await produto({ name: 'Algodão', tracksExpiry: false })

    expect((await alertas()).lowProducts).toBe(1)
  })

  it('AC-03: a entrada apaga o alerta de reposição sozinha', async () => {
    const id = await produto({ name: 'Shampoo', tracksExpiry: false, minQuantity: '10' })
    expect((await alertas()).lowProducts).toBe(1)

    await entrada(id, '12')

    expect((await alertas()).lowProducts).toBe(0)
  })

  it('conta o produto com saldo negativo, que é o uso sem entrada', async () => {
    const id = await produto({ name: 'Shampoo', tracksExpiry: false, unit: 'ML' })
    const uso = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/internal-use',
      payload: { productId: id, quantity: '40', idempotencyKey: chave() },
    })
    expect(uso.statusCode, uso.body).toBe(201)

    expect((await alertas()).negativeProducts).toBe(1)
  })

  it('produto desativado sai do sino, como sai da lista', async () => {
    const id = await produto({ name: 'Shampoo', tracksExpiry: false, minQuantity: '10' })
    await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${id}`,
      payload: { active: false },
    })

    expect((await alertas()).lowProducts).toBe(0)
  })

  it('o número do sino é o tamanho da lista filtrada para onde ele aponta', async () => {
    const a = await produto({ name: 'Vacina A', minQuantity: '10' })
    const b = await produto({ name: 'Vacina B' })
    await entrada(a, '3', { batchCode: 'A1', expiresAt: emDias(7) })
    await entrada(a, '3', { batchCode: 'A2', expiresAt: emDias(20) })
    await entrada(b, '3', { batchCode: 'B1', expiresAt: emDias(15) })

    const contagem = await alertas()
    const vencendo = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/products?alert=EXPIRING',
    })
    const repor = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/products?alert=LOW',
    })

    const lotesNaLista = (vencendo.json() as { expiringLots: number }[]).reduce(
      (soma, row) => soma + row.expiringLots,
      0,
    )
    expect(contagem.expiringLots).toBe(3)
    expect(lotesNaLista).toBe(contagem.expiringLots)
    expect((repor.json() as unknown[]).length).toBe(contagem.lowProducts)
  })

  it('quem dá banho vê as contagens: é quem abre a lista', async () => {
    await produto({ name: 'Shampoo', tracksExpiry: false, minQuantity: '10' })
    const banhista = await asRole(fixture, 'BATHER')

    expect((await alertas(banhista)).lowProducts).toBe(1)
  })

  it('o Starter recebe 402', async () => {
    const starter = await givenTenant('STARTER')
    const resposta = await callApi({
      ...asAdmin(starter),
      method: 'GET',
      url: '/v1/inventory/alerts',
    })
    expect(resposta.statusCode).toBe(402)
  })
})

// ─── A janela de validade ────────────────────────────────────────────────────

describe('a janela do alerta de validade', () => {
  it('ampliar a janela acende o lote que estava fora dela, na lista e no sino', async () => {
    const id = await produto()
    await entrada(id, '5', { batchCode: 'L45', expiresAt: emDias(45) })
    expect((await alertas()).expiringLots).toBe(0)

    const resposta = await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/inventory/settings',
      payload: { expiryWarningDays: 60 },
    })
    expect(resposta.statusCode, resposta.body).toBe(200)
    expect(resposta.json()).toEqual({ expiryWarningDays: 60 })

    expect(await alertas()).toMatchObject({ expiringLots: 1, expiryWarningDays: 60 })
    const detalhe = await callApi({ ...admin, method: 'GET', url: `/v1/inventory/products/${id}` })
    expect(detalhe.json().lots[0].expiring).toBe(true)

    const lido = await callApi({ ...admin, method: 'GET', url: '/v1/inventory/settings' })
    expect(lido.json()).toEqual({ expiryWarningDays: 60 })

    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId, action: 'inventory.settings_updated' },
    })
    expect(trilha?.before).toEqual({ expiryWarningDays: 30 })
    expect(trilha?.after).toEqual({ expiryWarningDays: 60 })
  })

  it('recusa zero e mais de 180 dias', async () => {
    for (const expiryWarningDays of [0, 181, 7.5]) {
      const resposta = await callApi({
        ...admin,
        method: 'PATCH',
        url: '/v1/inventory/settings',
        payload: { expiryWarningDays },
      })
      expect(resposta.statusCode, String(expiryWarningDays)).toBe(422)
      expect(resposta.json().code).toBe('ERR_INV_002')
    }
  })

  it('só o administrador muda a janela', async () => {
    const recepcao = await asRole(fixture, 'RECEPTIONIST')
    const resposta = await callApi({
      ...recepcao,
      method: 'PATCH',
      url: '/v1/inventory/settings',
      payload: { expiryWarningDays: 60 },
    })
    expect(resposta.statusCode).toBe(403)
  })
})

// ─── Posição e valorização (MOD-ESTOQUE-11) ─────────────────────────────────

describe('posição do estoque', () => {
  it('valoriza cada lote pelo custo dele, e não pelo último custo do produto', async () => {
    const id = await produto({ name: 'Vacina V10' })
    await entrada(id, '10', { batchCode: 'A', expiresAt: emDias(60), unitCostCents: 3_000 })
    await entrada(id, '5', { batchCode: 'B', expiresAt: emDias(90), unitCostCents: 3_400 })

    const relatorio = await posicao()

    expect(relatorio.products).toHaveLength(1)
    const [linha] = relatorio.products
    expect(linha!.quantityOnHand).toBe('15')
    // 10 × 30,00 + 5 × 34,00 — e não 15 × 34,00.
    expect(linha!.valueCents).toBe(47_000)
    expect(linha!.lots.map((lot) => lot.batchCode)).toEqual(['A', 'B'])
    expect(relatorio.totals).toMatchObject({ products: 1, lots: 2, valueCents: 47_000 })
    expect(relatorio.tenantName).toBe('Petshop Estoque')
  })

  it('arredonda o fracionado ao centavo, meio centavo para cima', async () => {
    const id = await produto({ name: 'Ração a granel', tracksExpiry: false, unit: 'KG' })
    await entrada(id, '0.375', { unitCostCents: 3_290 })

    // 0,375 × 32,90 = 12,3375 → R$ 12,34.
    expect((await posicao()).totals.valueCents).toBe(1_234)
  })

  it('lote sem custo e lote negativo ficam fora do total, e a contagem diz quantos', async () => {
    const custeado = await produto({
      name: 'Coleira',
      kind: 'RETAIL',
      salePriceCents: 5_000,
      tracksExpiry: false,
    })
    await entrada(custeado, '2', { unitCostCents: 2_000 })
    const semCusto = await produto({ name: 'Petisco', tracksExpiry: false })
    await entrada(semCusto, '4')
    const negativo = await produto({ name: 'Shampoo', tracksExpiry: false, unit: 'ML' })
    await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/internal-use',
      payload: { productId: negativo, quantity: '40', idempotencyKey: chave() },
    })

    const relatorio = await posicao()

    expect(relatorio.totals).toMatchObject({
      products: 3,
      valueCents: 4_000,
      uncostedLots: 1,
      negativeLots: 1,
    })
    const shampoo = relatorio.products.find((row) => row.name === 'Shampoo')!
    expect(shampoo.lots[0]!.valueCents).toBeNull()
    expect(shampoo.valueCents).toBe(0)
  })

  it('o desativado com saldo entra; o zerado e o excluído não', async () => {
    const inativo = await produto({ name: 'Antigo', tracksExpiry: false })
    await entrada(inativo, '3', { unitCostCents: 1_000 })
    await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${inativo}`,
      payload: { active: false },
    })
    await produto({ name: 'Sem entrada', tracksExpiry: false })

    const relatorio = await posicao()

    expect(relatorio.products.map((row) => row.name)).toEqual(['Antigo'])
    expect(relatorio.products[0]!.active).toBe(false)
  })

  it('filtra pelo tipo', async () => {
    const venda = await produto({
      name: 'Coleira',
      kind: 'RETAIL',
      salePriceCents: 5_000,
      tracksExpiry: false,
    })
    await entrada(venda, '1', { unitCostCents: 2_000 })
    const insumo = await produto({ name: 'Shampoo', tracksExpiry: false })
    await entrada(insumo, '1', { unitCostCents: 900 })

    const relatorio = await posicao('?kind=RETAIL')

    expect(relatorio.kind).toBe('RETAIL')
    expect(relatorio.products.map((row) => row.name)).toEqual(['Coleira'])
  })

  it('devolve o PDF como anexo, sem cópia pelo caminho', async () => {
    setPdfPort({
      async render() {
        return Buffer.from('%PDF-1.4 dublê')
      },
    })

    const resposta = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/reports/position/pdf',
    })

    expect(resposta.statusCode).toBe(200)
    expect(resposta.headers['content-type']).toBe('application/pdf')
    expect(resposta.headers['content-disposition']).toMatch(
      /^attachment; filename="posicao-do-estoque-\d{4}-\d{2}-\d{2}\.pdf"$/,
    )
    expect(resposta.headers['cache-control']).toBe('no-store')
  })

  it('vira 503 quando o Gotenberg não responde', async () => {
    setPdfPort({
      async render() {
        throw new PdfUnavailableError('Gotenberg fora do ar')
      },
    })

    const resposta = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/reports/position/pdf',
    })

    expect(resposta.statusCode).toBe(503)
    expect(resposta.json().code).toBe('ERR_DOC_005')
  })

  it('o HTML escapa o que foi digitado', () => {
    const html = renderPositionHtml({
      tenantName: 'Pet <b>',
      timezone: 'America/Sao_Paulo',
      asOf: '2026-09-25',
      generatedAt: '2026-09-25T15:00:00.000Z',
      kind: null,
      products: [
        {
          productId: '00000000-0000-4000-8000-000000000001',
          name: '<script>alert(1)</script>',
          sku: null,
          kind: 'SUPPLY',
          unit: 'UN',
          active: true,
          quantityOnHand: '2',
          valueCents: 200,
          lots: [
            {
              lotId: '00000000-0000-4000-8000-000000000002',
              batchCode: 'L<1>',
              expiresAt: '2026-09-20',
              quantityOnHand: '2',
              unitCostCents: 100,
              valueCents: 200,
              expired: true,
            },
          ],
        },
      ],
      totals: {
        products: 1,
        lots: 1,
        valueCents: 200,
        uncostedLots: 0,
        negativeLots: 0,
        expiredLots: 1,
      },
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Lote L&lt;1&gt;')
    expect(html).toContain('vencido')
  })
})

// ─── Reconciliação (MOD-ESTOQUE-12) ─────────────────────────────────────────

describe('reconciliação', () => {
  it('saldo que fecha com os movimentos não é divergência', async () => {
    const id = await produto({ tracksExpiry: false })
    await entrada(id, '10')
    await entrada(id, '2.5', { batchCode: 'B' })

    const resultado = await reconcileStock()

    expect(resultado).toMatchObject({ checked: 2, divergent: 0 })
  })

  it('RN-16: aponta o lote editado por fora, grava a trilha e não corrige', async () => {
    const id = await produto({ tracksExpiry: false })
    const lote = await entrada(id, '10')
    // Um segundo estabelecimento, são, na mesma varredura.
    const outro = await givenTenant()
    const outroProduto = await callApi({
      ...asAdmin(outro),
      method: 'POST',
      url: '/v1/inventory/products',
      payload: { name: 'Coleira', kind: 'SUPPLY' },
    })
    await callApi({
      ...asAdmin(outro),
      method: 'POST',
      url: '/v1/inventory/entries',
      payload: { productId: outroProduto.json().id, quantity: '1', idempotencyKey: chave() },
    })

    // A escrita que o módulo proíbe: o saldo mexido sem movimento.
    await ownerPrisma.stockLot.update({ where: { id: lote }, data: { quantityOnHand: 7 } })

    const resultado = await reconcileStock()

    expect(resultado.tenants).toBe(2)
    expect(resultado.checked).toBe(2)
    expect(resultado.divergences).toEqual([
      {
        tenantId: fixture.tenantId,
        lotId: lote,
        productId: id,
        onHand: '7',
        sumOfMovements: '10',
      },
    ])

    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId, action: 'inventory.reconciliation_divergence' },
    })
    expect(trilha?.entityId).toBe(lote)
    expect(trilha?.after).toMatchObject({ sumOfMovements: '10', difference: '3' })

    // Não corrige sozinho: quem corrige é um ajuste humano, com motivo.
    const depois = await ownerPrisma.stockLot.findUniqueOrThrow({ where: { id: lote } })
    expect(depois.quantityOnHand.toString()).toBe('7')
  })
})
