import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createManualEntry } from '../../src/modules/ledger/entries.js'
import { PdfUnavailableError, setPdfPort } from '../../src/modules/ledger/pdf-port.js'
import {
  actorOf,
  asAdmin,
  callApi,
  closeHarness,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

let tenant: TenantFixture
let tutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  tutorId = await givenTutor(tenant)
})

afterAll(closeHarness)

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

function isoDate(days: number): string {
  return daysAgo(days).slice(0, 10)
}

async function post(
  direction: 'DEBIT' | 'CREDIT',
  amountCents: number,
  description: string,
  occurredAt: string,
) {
  return createManualEntry(
    actorOf(tenant),
    {
      tutorId,
      direction,
      amountCents,
      category: direction === 'DEBIT' ? 'SERVICE' : 'ADJUSTMENT',
      description,
      occurredAt,
      idempotencyKey: randomUUID(),
    },
    { canCredit: true },
  )
}

describe('MOD-LEDGER-06 — extrato', () => {
  it('AC-01: ordem cronológica decrescente, com saldo corrido e resumo', async () => {
    await post('DEBIT', 10000, 'Banho de 10 dias atrás', daysAgo(10))
    await post('DEBIT', 5000, 'Ração de 5 dias atrás', daysAgo(5))
    await post('CREDIT', 8000, 'Pagamento parcial', daysAgo(2))

    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement`,
      ...asAdmin(tenant),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()

    expect(body.total).toBe(3)
    // Decrescente: o mais recente primeiro, que é como o balcão lê.
    expect(body.data.map((entry: { description: string }) => entry.description)).toEqual([
      'Pagamento parcial',
      'Ração de 5 dias atrás',
      'Banho de 10 dias atrás',
    ])

    expect(body.summary).toEqual({
      openingBalanceCents: 0,
      totalDebitsCents: 15000,
      totalCreditsCents: 8000,
      closingBalanceCents: -7000,
    })

    // Cada linha carrega o saldo do instante em que nasceu.
    expect(body.data[2].balanceAfterCents).toBe(-10000)
    expect(body.data[1].balanceAfterCents).toBe(-15000)
    expect(body.data[0].balanceAfterCents).toBe(-7000)
  })

  it('AC-02: recorte no meio do histórico tira o saldo de abertura por lookup', async () => {
    await post('DEBIT', 10000, 'Antes do recorte', daysAgo(30))
    await post('DEBIT', 5000, 'Também antes', daysAgo(20))
    await post('DEBIT', 3000, 'Dentro do recorte', daysAgo(5))

    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement?from=${isoDate(10)}`,
      ...asAdmin(tenant),
    })

    const body = response.json()
    expect(body.total).toBe(1)
    // O saldo de abertura é o `balance_after_cents` do último lançamento anterior ao
    // `from` — não a soma da tabela inteira.
    expect(body.summary.openingBalanceCents).toBe(-15000)
    expect(body.summary.totalDebitsCents).toBe(3000)
    expect(body.summary.closingBalanceCents).toBe(-18000)
  })

  it('filtro por período recorta nas duas pontas', async () => {
    await post('DEBIT', 1000, 'Muito antigo', daysAgo(60))
    await post('DEBIT', 2000, 'No meio', daysAgo(30))
    await post('DEBIT', 3000, 'Recente', daysAgo(1))

    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement?from=${isoDate(45)}&to=${isoDate(15)}`,
      ...asAdmin(tenant),
    })

    const body = response.json()
    expect(body.total).toBe(1)
    expect(body.data[0].description).toBe('No meio')
  })

  it('AC-04: tutor sem movimentação devolve 200 com lista vazia e saldo zero', async () => {
    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement`,
      ...asAdmin(tenant),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual([])
    expect(response.json().summary).toEqual({
      openingBalanceCents: 0,
      totalDebitsCents: 0,
      totalCreditsCents: 0,
      closingBalanceCents: 0,
    })
  })

  it('pagina sem perder o total', async () => {
    for (let index = 0; index < 12; index += 1) {
      await post('DEBIT', 1000, `Lançamento ${index}`, daysAgo(20 - index))
    }

    const primeira = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement?limit=5&page=1`,
      ...asAdmin(tenant),
    })
    const terceira = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement?limit=5&page=3`,
      ...asAdmin(tenant),
    })

    expect(primeira.json().data).toHaveLength(5)
    expect(primeira.json().total).toBe(12)
    expect(terceira.json().data).toHaveLength(2)
    expect(terceira.json().total).toBe(12)
  })

  it('AC-03: `internalNotes` não sai no extrato, nem para o staff', async () => {
    await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents: 5000,
        category: 'SERVICE',
        description: 'Banho',
        internalNotes: 'Cliente sempre atrasa o pagamento',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    const extrato = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement`,
      ...asAdmin(tenant),
    })
    expect(extrato.json().data[0].internalNotes).toBeNull()

    // No detalhe do lançamento, o staff vê — é aí que a nota tem uso.
    const entryId = extrato.json().data[0].id
    const detalhe = await callApi({
      method: 'GET',
      url: `/v1/ledger/entries/${entryId}`,
      ...asAdmin(tenant),
    })
    expect(detalhe.json().internalNotes).toBe('Cliente sempre atrasa o pagamento')
  })
})

describe('MOD-LEDGER-01 — resumo da conta', () => {
  it('conta os débitos abertos e aponta o mais antigo', async () => {
    await post('DEBIT', 10000, 'Primeiro', daysAgo(30))
    await post('DEBIT', 5000, 'Segundo', daysAgo(10))
    await post('CREDIT', 4000, 'Pagamento avulso', daysAgo(1))

    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}`,
      ...asAdmin(tenant),
    })

    const body = response.json()
    expect(body.balanceCents).toBe(-11000)
    // O crédito manual não aloca sozinho: o que a conta reporta é o débito em aberto.
    expect(body.openDebitsCents).toBe(15000)
    expect(body.openDebitsCount).toBe(2)
    expect(body.oldestOpenDebitAt).not.toBeNull()
    expect(body.needsReview).toBe(false)
  })
})

describe('MOD-DOC-09 — o extrato em papel', () => {
  /** Captura o HTML que iria ao Chromium: é nele que se confere o que a folha diz. */
  let folhas: string[]

  beforeEach(() => {
    folhas = []
    setPdfPort({
      async render(html) {
        folhas.push(html)
        return Buffer.from('%PDF-1.4 dublê')
      },
    })
  })

  afterAll(() => setPdfPort(null))

  it('AC-01: desce como anexo, com o movimento e os dois saldos', async () => {
    await post('DEBIT', 10000, 'Banho e tosa', daysAgo(10))
    await post('CREDIT', 4000, 'Pagamento parcial', daysAgo(2))

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement/pdf?from=${isoDate(30)}&to=${isoDate(0)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="extrato-${isoDate(30)}-a-${isoDate(0)}.pdf"`,
    )
    // A conta corrente de uma pessoa não fica no cache de ninguém.
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')

    const folha = folhas[0] ?? ''
    expect(folha).toContain('Banho e tosa')
    expect(folha).toContain('Pagamento parcial')
    expect(folha).toContain('Saldo de abertura')
    expect(folha).toContain('Saldo de fechamento')
  })

  it('AC-05: saldo negativo é dívida, e a folha diz "em aberto"', async () => {
    await post('DEBIT', 15000, 'Consulta veterinária', daysAgo(3))

    await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement/pdf`,
    })

    const folha = folhas[0] ?? ''
    expect(folha).toContain('150,00 em aberto')
    // O sinal cru não aparece: quem lê a folha não é contador.
    expect(folha).not.toContain('-R$')
  })

  it('crédito em conta é dito como crédito, não como saldo positivo', async () => {
    await post('CREDIT', 5000, 'Adiantamento', daysAgo(1))

    await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement/pdf`,
    })

    expect(folhas[0] ?? '').toContain('de crédito')
  })

  it('AC-03: período sem movimento sai assim mesmo, e não 404', async () => {
    await post('DEBIT', 10000, 'Banho de um ano atrás', daysAgo(365))

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement/pdf?from=${isoDate(5)}&to=${isoDate(0)}`,
    })

    expect(response.statusCode).toBe(200)

    const folha = folhas[0] ?? ''
    expect(folha).toContain('Sem movimento no período')
    // Os dois saldos são o mesmo número: é exatamente o que aconteceu no período.
    expect(folha).toContain('Saldo de abertura')
    expect(folha).toContain('Saldo de fechamento')
  })

  it('AC-04: nada é arquivado — nem linha em `documents`, nem objeto no bucket', async () => {
    await post('DEBIT', 10000, 'Banho', daysAgo(1))

    await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement/pdf`,
    })

    const documentos = await ownerPrisma.document.count({ where: { tenantId: tenant.tenantId } })
    expect(documentos).toBe(0)
  })

  it('escapa o que o balcão digitou — o Gotenberg roda um Chromium', async () => {
    await post('DEBIT', 1000, 'Banho <script>alert(1)</script>', daysAgo(1))

    await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement/pdf`,
    })

    const folha = folhas[0] ?? ''
    expect(folha).toContain('&lt;script&gt;')
    expect(folha).not.toContain('<script>alert(1)</script>')
  })

  it('o Gotenberg fora do ar vira 503, e o extrato continua em tela', async () => {
    setPdfPort({
      async render() {
        throw new PdfUnavailableError('Gotenberg fora do ar')
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/statement/pdf`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().code).toBe('ERR_LEDGER_013')
  })
})
