import { afterAll, beforeEach, describe, expect, it } from 'vitest'
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
 * MOD-ESTOQUE, fatia 1: cadastro, entrada, ajuste e saldo.
 *
 * O que estes testes seguram é o contrato do razão de movimentos: **o saldo do lote é
 * sempre a soma dos movimentos dele**, nenhum movimento muda depois de gravado, e o
 * duplo clique não grava duas vezes.
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

interface Produto {
  id: string
  quantityOnHand: string
  belowMinimum: boolean
  expiringLots: number
  tracksExpiry: boolean
  unit: string
  costCents: number | null
  lots: {
    id: string
    batchCode: string
    quantityOnHand: string
    unitCostCents: number | null
    expiring: boolean
  }[]
  deletable: boolean
}

async function criarProduto(corpo: Record<string, unknown> = {}): Promise<Produto> {
  const resposta = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/products',
    payload: { name: 'Vacina V10', kind: 'SUPPLY', unit: 'UN', tracksExpiry: true, ...corpo },
  })
  expect(resposta.statusCode, resposta.body).toBe(201)
  return resposta.json() as Produto
}

async function entrada(corpo: Record<string, unknown>, caller: Caller = admin) {
  return callApi({
    ...caller,
    method: 'POST',
    url: '/v1/inventory/entries',
    payload: { idempotencyKey: chave(), ...corpo },
  })
}

async function ajuste(corpo: Record<string, unknown>) {
  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/adjustments',
    payload: { idempotencyKey: chave(), ...corpo },
  })
}

async function ler(id: string): Promise<Produto> {
  const resposta = await callApi({ ...admin, method: 'GET', url: `/v1/inventory/products/${id}` })
  expect(resposta.statusCode, resposta.body).toBe(200)
  return resposta.json() as Produto
}

/** RN-02: o saldo materializado de cada lote bate com a soma dos movimentos dele. */
async function conferirRazao(productId: string) {
  const lotes = await ownerPrisma.stockLot.findMany({ where: { productId } })
  for (const lote of lotes) {
    const soma = await ownerPrisma.stockMovement.aggregate({
      where: { lotId: lote.id },
      _sum: { quantity: true },
    })
    expect(soma._sum.quantity?.toString() ?? '0').toBe(lote.quantityOnHand.toString())
  }
}

// ─── Porta ───────────────────────────────────────────────────────────────────

describe('quem alcança o estoque', () => {
  it('o Starter recebe 402 antes da permissão', async () => {
    const starter = await givenTenant('STARTER')
    const resposta = await callApi({
      ...asAdmin(starter),
      method: 'GET',
      url: '/v1/inventory/products',
    })

    expect(resposta.statusCode).toBe(402)
    expect(resposta.json().code).toBe('ERR_PLAN_001')
  })

  it('a equipe lê, e só o administrador escreve', async () => {
    const produto = await criarProduto()

    for (const papel of ['RECEPTIONIST', 'VET', 'GROOMER', 'BATHER']) {
      const membro = await asRole(fixture, papel)
      const leitura = await callApi({ ...membro, method: 'GET', url: '/v1/inventory/products' })
      expect(leitura.statusCode, papel).toBe(200)

      const escrita = await entrada(
        { productId: produto.id, batchCode: 'A1', expiresAt: emDias(200), quantity: '1' },
        membro,
      )
      expect(escrita.statusCode, papel).toBe(403)
      expect(escrita.json().code).toBe('ERR_INV_009')
    }
  })

  it('o motorista nem lê', async () => {
    const motorista = await asRole(fixture, 'DRIVER')
    const resposta = await callApi({ ...motorista, method: 'GET', url: '/v1/inventory/products' })
    expect(resposta.statusCode).toBe(403)
  })

  it('o produto de outro estabelecimento não existe', async () => {
    const produto = await criarProduto()
    const vizinho = await givenTenant()
    const resposta = await callApi({
      ...asAdmin(vizinho),
      method: 'GET',
      url: `/v1/inventory/products/${produto.id}`,
    })
    expect(resposta.statusCode).toBe(404)
  })
})

// ─── Cadastro (MOD-ESTOQUE-01) ───────────────────────────────────────────────

describe('cadastro de produto', () => {
  it('nasce ativo, com saldo zero e sem lote', async () => {
    const produto = await criarProduto()
    expect(produto.quantityOnHand).toBe('0')
    expect(produto.lots).toEqual([])
    expect(produto.deletable).toBe(true)
  })

  it('produto de venda sem preço é recusado (AC-02)', async () => {
    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/products',
      payload: { name: 'Ração 15 kg', kind: 'RETAIL' },
    })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_002')
    expect(resposta.json().errors[0].field).toBe('salePriceCents')
  })

  it('trocar para venda sem mandar preço também é recusado', async () => {
    const produto = await criarProduto()
    const resposta = await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${produto.id}`,
      payload: { kind: 'BOTH' },
    })
    expect(resposta.statusCode).toBe(422)
  })

  it('o PATCH parcial não grava os padrões do cadastro por cima', async () => {
    const produto = await criarProduto({ unit: 'ML' })
    const resposta = await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${produto.id}`,
      payload: { name: 'Vacina V10 importada' },
    })
    expect(resposta.statusCode).toBe(200)
    // A armadilha do `.partial()`: `unit` e `tracksExpiry` têm default no cadastro.
    expect(resposta.json()).toMatchObject({ unit: 'ML', tracksExpiry: true })
  })

  it('SKU repetido é recusado no campo, e o de produto excluído volta a ficar livre', async () => {
    const primeiro = await criarProduto({ sku: 'V10' })
    const repetido = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/products',
      payload: { name: 'Outra vacina', kind: 'SUPPLY', sku: 'V10' },
    })
    expect(repetido.statusCode).toBe(422)
    expect(repetido.json().errors[0].field).toBe('sku')

    await callApi({ ...admin, method: 'DELETE', url: `/v1/inventory/products/${primeiro.id}` })
    await criarProduto({ sku: 'V10' })
  })

  it('só o produto sem movimento é excluído (AC-03)', async () => {
    const produto = await criarProduto()
    await entrada({ productId: produto.id, batchCode: 'A1', expiresAt: emDias(200), quantity: '2' })

    const resposta = await callApi({
      ...admin,
      method: 'DELETE',
      url: `/v1/inventory/products/${produto.id}`,
    })
    expect(resposta.statusCode).toBe(409)
    expect(resposta.json().code).toBe('ERR_INV_004')

    const desativado = await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${produto.id}`,
      payload: { active: false },
    })
    expect(desativado.statusCode).toBe(200)

    const lista = await callApi({ ...admin, method: 'GET', url: '/v1/inventory/products' })
    expect(lista.json()).toHaveLength(0)
    const comInativos = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/products?includeInactive=true',
    })
    expect(comInativos.json()).toHaveLength(1)
  })

  it('a unidade não muda depois do primeiro movimento', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    await entrada({ productId: produto.id, quantity: '500' })

    const resposta = await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${produto.id}`,
      payload: { unit: 'ML' },
    })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().errors[0].field).toBe('unit')
  })
})

// ─── Entrada (MOD-ESTOQUE-02/03) ─────────────────────────────────────────────

describe('entrada de mercadoria', () => {
  it('produto que controla validade não entra sem ela', async () => {
    const produto = await criarProduto()
    const resposta = await entrada({ productId: produto.id, batchCode: 'A1', quantity: '10' })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_003')
  })

  it('a segunda entrada do mesmo lote soma no lote', async () => {
    const produto = await criarProduto()
    const validade = emDias(200)
    await entrada({ productId: produto.id, batchCode: 'a1', expiresAt: validade, quantity: '10' })
    const segunda = await entrada({
      productId: produto.id,
      batchCode: 'A1',
      expiresAt: validade,
      quantity: '5',
    })
    expect(segunda.statusCode).toBe(201)

    const lido = await ler(produto.id)
    expect(lido.lots).toHaveLength(1)
    // O código do lote é normalizado: "a1" e "A1" são o mesmo lote.
    expect(lido.lots[0]).toMatchObject({ batchCode: 'A1', quantityOnHand: '15' })
    expect(lido.quantityOnHand).toBe('15')
    await conferirRazao(produto.id)
  })

  it('o mesmo lote com outra validade é erro de digitação (AC-02)', async () => {
    const produto = await criarProduto()
    await entrada({
      productId: produto.id,
      batchCode: 'A1',
      expiresAt: emDias(200),
      quantity: '10',
    })
    const resposta = await entrada({
      productId: produto.id,
      batchCode: 'A1',
      expiresAt: emDias(300),
      quantity: '5',
    })
    expect(resposta.statusCode).toBe(409)
    expect(resposta.json().code).toBe('ERR_INV_005')
    expect((await ler(produto.id)).quantityOnHand).toBe('10')
  })

  it('sem código de lote, a entrada cai no lote implícito', async () => {
    const produto = await criarProduto({
      name: 'Coleira M',
      kind: 'RETAIL',
      salePriceCents: 3990,
      tracksExpiry: false,
    })
    await entrada({ productId: produto.id, quantity: '3' })
    await entrada({ productId: produto.id, quantity: '2' })

    const lido = await ler(produto.id)
    expect(lido.lots).toHaveLength(1)
    expect(lido.lots[0]).toMatchObject({ batchCode: 'SEM-LOTE', quantityOnHand: '5' })
  })

  it('aceita quantidade fracionada com vírgula, como o balcão digita', async () => {
    const produto = await criarProduto({ name: 'Shampoo neutro', unit: 'L', tracksExpiry: false })
    await entrada({ productId: produto.id, quantity: '2,5' })
    await entrada({ productId: produto.id, quantity: '0.125' })
    expect((await ler(produto.id)).quantityOnHand).toBe('2.625')
  })

  it('o custo do lote é a média das entradas, e o do produto é o da última', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    await entrada({ productId: produto.id, batchCode: 'L1', quantity: '10', unitCostCents: 100 })
    await entrada({ productId: produto.id, batchCode: 'L1', quantity: '10', unitCostCents: 200 })

    const lido = await ler(produto.id)
    expect(lido.lots[0]?.unitCostCents).toBe(150)
    expect(lido.costCents).toBe(200)
  })

  it('duas entradas simultâneas do mesmo lote novo somam as duas', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    const respostas = await Promise.all(
      Array.from({ length: 5 }, () =>
        entrada({ productId: produto.id, batchCode: 'NOVO', quantity: '1' }),
      ),
    )
    expect(respostas.map((resposta) => resposta.statusCode)).toEqual([201, 201, 201, 201, 201])
    expect((await ler(produto.id)).quantityOnHand).toBe('5')
    await conferirRazao(produto.id)
  })

  it('produto desativado não recebe entrada', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/inventory/products/${produto.id}`,
      payload: { active: false },
    })
    const resposta = await entrada({ productId: produto.id, quantity: '1' })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_007')
  })
})

// ─── Idempotência ────────────────────────────────────────────────────────────

describe('o duplo clique', () => {
  it('a mesma chave com o mesmo conteúdo devolve o que já gravou', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    const corpo = { productId: produto.id, quantity: '4', idempotencyKey: chave() }

    const primeira = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/entries',
      payload: corpo,
    })
    const segunda = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/entries',
      payload: corpo,
    })

    expect(primeira.statusCode).toBe(201)
    expect(segunda.statusCode).toBe(200)
    expect(segunda.json().repeated).toBe(true)
    expect(segunda.json().movement.id).toBe(primeira.json().movement.id)
    expect((await ler(produto.id)).quantityOnHand).toBe('4')
  })

  it('a mesma chave com outro conteúdo é recusada', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    const idempotencyKey = chave()
    await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/entries',
      payload: { productId: produto.id, quantity: '4', idempotencyKey },
    })
    const outra = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/inventory/entries',
      payload: { productId: produto.id, quantity: '40', idempotencyKey },
    })
    expect(outra.statusCode).toBe(409)
    expect(outra.json().code).toBe('ERR_INV_013')
  })

  it('cliques simultâneos gravam um movimento só', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    const corpo = { productId: produto.id, quantity: '1', idempotencyKey: chave() }

    const respostas = await Promise.all(
      Array.from({ length: 4 }, () =>
        callApi({ ...admin, method: 'POST', url: '/v1/inventory/entries', payload: corpo }),
      ),
    )
    expect(respostas.every((resposta) => [200, 201].includes(resposta.statusCode))).toBe(true)
    expect(await ownerPrisma.stockMovement.count({ where: { productId: produto.id } })).toBe(1)
    expect((await ler(produto.id)).quantityOnHand).toBe('1')
  })
})

// ─── Ajuste e perda (MOD-ESTOQUE-04) ─────────────────────────────────────────

describe('ajuste e perda', () => {
  async function produtoCom(quantidade: string) {
    const produto = await criarProduto()
    await entrada({
      productId: produto.id,
      batchCode: 'A1',
      expiresAt: emDias(200),
      quantity: quantidade,
    })
    const lido = await ler(produto.id)
    return { produto, lote: lido.lots[0]! }
  }

  it('a contagem informa o saldo, e o sistema grava a diferença (AC-02)', async () => {
    const { produto, lote } = await produtoCom('10')
    const resposta = await ajuste({
      lotId: lote.id,
      mode: 'COUNT',
      quantity: '7',
      reason: 'Contagem de sexta',
    })

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(resposta.json().movement).toMatchObject({
      type: 'ADJUSTMENT',
      quantity: '-3',
      quantityAfter: '7',
    })
    expect(resposta.json().lot.quantityOnHand).toBe('7')
    await conferirRazao(produto.id)
  })

  it('ajuste sem motivo é recusado', async () => {
    const { lote } = await produtoCom('10')
    const resposta = await ajuste({ lotId: lote.id, mode: 'COUNT', quantity: '7', reason: '' })
    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().errors[0].field).toBe('reason')
  })

  it('contagem igual ao saldo não grava nada', async () => {
    const { produto, lote } = await produtoCom('10')
    const resposta = await ajuste({
      lotId: lote.id,
      mode: 'COUNT',
      quantity: '10',
      reason: 'Conferência',
    })
    expect(resposta.statusCode).toBe(422)
    expect(await ownerPrisma.stockMovement.count({ where: { productId: produto.id } })).toBe(1)
  })

  it('perda só tira', async () => {
    const { lote } = await produtoCom('10')
    const sobe = await ajuste({
      lotId: lote.id,
      type: 'LOSS',
      mode: 'COUNT',
      quantity: '12',
      reason: 'Quebra',
    })
    expect(sobe.statusCode).toBe(422)

    const descarte = await ajuste({
      lotId: lote.id,
      type: 'LOSS',
      mode: 'COUNT',
      quantity: '0',
      reason: 'Vencido',
    })
    expect(descarte.statusCode).toBe(201)
    expect(descarte.json().movement).toMatchObject({
      type: 'LOSS',
      quantity: '-10',
      quantityAfter: '0',
    })
  })

  it('a diferença pode levar o lote abaixo de zero, e o saldo continua sendo a soma', async () => {
    const { produto, lote } = await produtoCom('2')
    await ajuste({
      lotId: lote.id,
      mode: 'DELTA',
      quantity: '-5',
      reason: 'Correção de lançamento',
    })

    const negativos = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/products?alert=NEGATIVE',
    })
    expect(negativos.json()).toHaveLength(1)
    expect((await ler(produto.id)).quantityOnHand).toBe('-3')
    await conferirRazao(produto.id)
  })
})

// ─── O razão ─────────────────────────────────────────────────────────────────

describe('o movimento é imutável (RN-01)', () => {
  it('nem o dono do banco edita ou apaga um movimento', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    await entrada({ productId: produto.id, quantity: '3' })
    const movimento = await ownerPrisma.stockMovement.findFirstOrThrow({
      where: { productId: produto.id },
    })

    await expect(
      ownerPrisma.stockMovement.update({ where: { id: movimento.id }, data: { reason: 'mexido' } }),
    ).rejects.toThrow(/ERR_INV_014/)
    await expect(ownerPrisma.stockMovement.delete({ where: { id: movimento.id } })).rejects.toThrow(
      /ERR_INV_014/,
    )
  })

  it('apagar o estabelecimento leva o estoque junto', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    await entrada({ productId: produto.id, quantity: '3' })

    await ownerPrisma.tenant.delete({ where: { id: fixture.tenantId } })
    expect(await ownerPrisma.stockMovement.count({ where: { productId: produto.id } })).toBe(0)
    expect(await ownerPrisma.product.count({ where: { id: produto.id } })).toBe(0)
  })

  it('o histórico traz o autor e pagina do mais novo para o mais velho', async () => {
    const produto = await criarProduto({ tracksExpiry: false })
    for (const quantidade of ['1', '2', '3'])
      await entrada({ productId: produto.id, quantity: quantidade })

    const primeira = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/inventory/products/${produto.id}/movements?limit=2`,
    })
    const pagina = primeira.json() as {
      items: { quantity: string; createdByName: string }[]
      nextCursor: string
    }
    expect(pagina.items.map((item) => item.quantity)).toEqual(['3', '2'])
    expect(pagina.items[0]?.createdByName).toBe('Gerente de Estoque')

    const segunda = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/inventory/products/${produto.id}/movements?limit=2&cursor=${pagina.nextCursor}`,
    })
    expect(segunda.json().items.map((item: { quantity: string }) => item.quantity)).toEqual(['1'])
    expect(segunda.json().nextCursor).toBeNull()
  })
})

// ─── Alertas (MOD-ESTOQUE-09, a leitura) ──────────────────────────────────────

describe('os alertas da lista', () => {
  it('abaixo do mínimo', async () => {
    const produto = await criarProduto({ tracksExpiry: false, minQuantity: '5' })
    await entrada({ productId: produto.id, quantity: '3' })
    await criarProduto({ name: 'Sem mínimo', tracksExpiry: false })

    const baixos = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/products?alert=LOW',
    })
    expect(baixos.json().map((row: { id: string }) => row.id)).toEqual([produto.id])
  })

  it('lote vencendo na janela de 30 dias, e só se ainda houver saldo', async () => {
    const vencendo = await criarProduto({ name: 'Antipulgas' })
    await entrada({ productId: vencendo.id, batchCode: 'P1', expiresAt: emDias(10), quantity: '4' })
    await entrada({
      productId: vencendo.id,
      batchCode: 'P2',
      expiresAt: emDias(300),
      quantity: '4',
    })

    const zerado = await criarProduto({ name: 'Vermífugo' })
    await entrada({ productId: zerado.id, batchCode: 'V1', expiresAt: emDias(10), quantity: '1' })
    const lote = (await ler(zerado.id)).lots[0]!
    await ajuste({ lotId: lote.id, mode: 'COUNT', quantity: '0', reason: 'Usado' })

    const lista = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/products?alert=EXPIRING',
    })
    expect(lista.json().map((row: { id: string }) => row.id)).toEqual([vencendo.id])
    expect(lista.json()[0]).toMatchObject({ expiringLots: 1, nextExpiresAt: emDias(10) })

    const lido = await ler(vencendo.id)
    expect(lido.lots.map((item) => [item.batchCode, item.expiring])).toEqual([
      ['P1', true],
      ['P2', false],
    ])
  })

  it('a busca acha pelo nome sem diferença de caixa e pelo SKU', async () => {
    await criarProduto({ name: 'Shampoo Neutro', sku: 'SH-01', tracksExpiry: false })
    await criarProduto({ name: 'Vacina V8', tracksExpiry: false })

    const porNome = await callApi({
      ...admin,
      method: 'GET',
      url: '/v1/inventory/products?q=shampoo',
    })
    expect(porNome.json()).toHaveLength(1)
    const porSku = await callApi({ ...admin, method: 'GET', url: '/v1/inventory/products?q=sh-01' })
    expect(porSku.json()).toHaveLength(1)
  })
})
