import { randomUUID } from 'node:crypto'
import { withTenant } from '@petshop/db'
import type { PaymentMethod } from '@petshop/shared-types'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdfUnavailableError, setPdfPort } from '../src/lib/pdf.js'
import { openCipher } from '../src/modules/ledger/crypto.js'
import { createManualEntry } from '../src/modules/ledger/entries.js'
import { recordPayment } from '../src/modules/ledger/payments.js'
import {
  accountsReceivableReport,
  receiptsByDayReport,
} from '../src/modules/ledger/reports.js'
import {
  actorOf,
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * Os dois relatórios do menu Cobrança.
 *
 * O que vale a pena provar aqui não é que a soma soma — é o que separa estes números
 * dos que o painel já mostrava: o envelhecimento contado de `occurred_at`, o débito
 * parcialmente quitado entrando pelo **saldo** e não pelo valor cheio, o dia agrupado
 * no fuso do estabelecimento e não em UTC, e o pagamento revertido ficando de fora.
 */

let tenant: TenantFixture
let tutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant('Petshop do João')
  tutorId = await givenTutor(tenant, 'Maria Silva')
})

afterEach(() => setPdfPort(null))
afterAll(closeHarness)

const DAY_MS = 86_400_000

async function debitar(amountCents: number, daysAgo: number, tutor = tutorId) {
  return createManualEntry(
    actorOf(tenant),
    {
      tutorId: tutor,
      direction: 'DEBIT',
      amountCents,
      category: 'SERVICE',
      description: `Banho de ${daysAgo} dias atrás`,
      occurredAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
      idempotencyKey: randomUUID(),
    },
    { canCredit: true },
  )
}

async function pagar(
  amountCents: number,
  receivedAt: Date,
  method: PaymentMethod = 'CASH',
) {
  return recordPayment(actorOf(tenant), {
    tutorId,
    amountCents,
    method,
    receivedAt: receivedAt.toISOString(),
    idempotencyKey: randomUUID(),
  })
}

/** Grava um telefone de verdade, cifrado com a DEK do tenant. */
async function comTelefone(tutor: string, e164: string): Promise<void> {
  await withTenant(tenant.tenantId, async (tx) => {
    const cipher = await openCipher(tx, tenant.tenantId)
    await tx.tutor.update({
      where: { id: tutor },
      data: { phoneEncrypted: cipher.encrypt(e164) },
    })
  })
}

describe('contas a receber', () => {
  it('separa a dívida por faixa a partir da data do fato gerador', async () => {
    await debitar(10_000, 5)
    await debitar(20_000, 45)
    await debitar(30_000, 90)

    const report = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 0 })

    expect(report.buckets).toEqual({ '0_30d': 10_000, '30_60d': 20_000, '60d_plus': 30_000 })
    expect(report.totalCents).toBe(60_000)
    expect(report.tutorsCount).toBe(1)
    expect(report.rows[0]?.openEntries).toBe(3)
    // O tutor entra uma vez só, com as três faixas na mesma linha.
    expect(report.rows).toHaveLength(1)
  })

  it('conta apenas o saldo do débito parcialmente quitado', async () => {
    await debitar(10_000, 10)
    await pagar(4_000, new Date())

    const report = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 0 })

    // O pagamento quitou 40 dos 100 pelo FIFO; o relatório cobra os 60 que sobraram.
    expect(report.totalCents).toBe(6_000)
  })

  it('ignora o débito já quitado por inteiro', async () => {
    await debitar(10_000, 10)
    await pagar(10_000, new Date())

    const report = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 0 })

    expect(report.rows).toEqual([])
    expect(report.totalCents).toBe(0)
  })

  it('respeita o corte por atraso mínimo', async () => {
    const outro = await givenTutor(tenant, 'João Pereira')
    await debitar(10_000, 2)
    await debitar(50_000, 70, outro)

    const todos = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 0 })
    const velhos = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 60 })

    expect(todos.tutorsCount).toBe(2)
    expect(velhos.tutorsCount).toBe(1)
    expect(velhos.rows[0]?.tutorName).toBe('João Pereira')
    // Os totais somam o que está listado, não a base inteira.
    expect(velhos.totalCents).toBe(50_000)
  })

  it('devolve o telefone decifrado e o nome social quando houver', async () => {
    await comTelefone(tutorId, '+5511987654321')
    await withTenant(tenant.tenantId, (tx) =>
      tx.tutor.update({ where: { id: tutorId }, data: { socialName: 'Mari' } }),
    )
    await debitar(10_000, 3)

    const report = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 0 })

    expect(report.rows[0]?.phone).toBe('+5511987654321')
    // RN-14: quem tem nome social é chamado por ele — e cobrança é comunicação.
    expect(report.rows[0]?.tutorName).toBe('Mari')
  })

  it('não derruba o relatório quando o telefone não decifra', async () => {
    // `givenTutor` grava `v1:teste`, que não é payload válido: é o cenário de chave
    // trocada, e ele não pode custar a lista de quem está devendo.
    await debitar(10_000, 3)

    const report = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 0 })

    expect(report.rows[0]?.phone).toBeNull()
    expect(report.totalCents).toBe(10_000)
  })

  it('não enxerga o débito de outro tenant', async () => {
    const vizinho = await givenTenant('Petshop Vizinho')
    const tutorVizinho = await givenTutor(vizinho, 'Alheio')
    await createManualEntry(
      actorOf(vizinho),
      {
        tutorId: tutorVizinho,
        direction: 'DEBIT',
        amountCents: 99_000,
        category: 'SERVICE',
        description: 'Do vizinho',
        occurredAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )
    await debitar(10_000, 1)

    const report = await accountsReceivableReport(tenant.tenantId, { minOverdueDays: 0 })

    expect(report.totalCents).toBe(10_000)
    expect(report.rows).toHaveLength(1)
  })
})

describe('contas recebidas por dia', () => {
  it('agrupa por dia e por forma de pagamento', async () => {
    const hoje = new Date()
    const ontem = new Date(hoje.getTime() - DAY_MS)

    await debitar(100_000, 30)
    await pagar(10_000, ontem, 'CASH')
    await pagar(5_000, ontem, 'PIX_MANUAL')
    await pagar(20_000, hoje, 'CASH')

    const from = isoIn(new Date(hoje.getTime() - 3 * DAY_MS))
    const report = await receiptsByDayReport(tenant.tenantId, { from, to: isoIn(hoje) })

    expect(report.totalCents).toBe(35_000)
    expect(report.paymentsCount).toBe(3)
    expect(report.days).toHaveLength(2)
    // Dia sem movimento não vira linha vazia.
    expect(report.days.map((day) => day.totalCents)).toEqual([15_000, 20_000])

    const dinheiro = report.byMethod.find((item) => item.method === 'CASH')
    expect(dinheiro).toEqual({ method: 'CASH', totalCents: 30_000, count: 2 })
  })

  it('deixa de fora o pagamento revertido', async () => {
    const hoje = new Date()
    await debitar(100_000, 30)
    const pago = await pagar(30_000, hoje)

    const { reversePayment } = await import('../src/modules/ledger/payments.js')
    await reversePayment(actorOf(tenant), pago.paymentId, 'Registrado em duplicidade')

    const report = await receiptsByDayReport(tenant.tenantId, {
      from: isoIn(hoje),
      to: isoIn(hoje),
    })

    // Dinheiro estornado nunca entrou.
    expect(report.totalCents).toBe(0)
    expect(report.days).toEqual([])
  })

  it('recusa período invertido e janela grande demais', async () => {
    await expect(
      receiptsByDayReport(tenant.tenantId, { from: '2026-03-01', to: '2026-02-01' }),
    ).rejects.toThrow(/posterior à final/)

    await expect(
      receiptsByDayReport(tenant.tenantId, { from: '2020-01-01', to: '2026-01-01' }),
    ).rejects.toThrow(/período/)
  })

  it('sem período, resolve o mês corrente no fuso do estabelecimento', async () => {
    const report = await receiptsByDayReport(tenant.tenantId, {})

    expect(report.timezone).toBe('America/Sao_Paulo')
    expect(report.from.endsWith('-01')).toBe(true)
    expect(report.from.slice(0, 7)).toBe(report.to.slice(0, 7))
  })
})

describe('as rotas', () => {
  it('recusa quem só tem finance:read', async () => {
    const response = await callApi({
      ...asReceptionist(tenant),
      method: 'GET',
      url: '/v1/ledger/reports/accounts-receivable',
    })

    expect(response.statusCode).toBe(403)
  })

  it('devolve o relatório em JSON', async () => {
    await debitar(10_000, 3)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/ledger/reports/accounts-receivable',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.tenantName).toBe('Petshop do João')
    expect(body.totalCents).toBe(10_000)
  })

  it('devolve o PDF como anexo, com nome que traz a data-base', async () => {
    setPdfPort({ async render() { return Buffer.from('%PDF-1.4 dublê') } })
    await debitar(10_000, 3)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/ledger/reports/accounts-receivable/pdf?asOf=2026-09-02',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="contas-a-receber-2026-09-02.pdf"',
    )
    // O relatório leva telefone de quem deve: ninguém guarda cópia pelo caminho.
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('vira 503 quando o Gotenberg não responde', async () => {
    setPdfPort({
      async render() {
        throw new PdfUnavailableError('Gotenberg fora do ar')
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/ledger/reports/receipts-by-day/pdf',
    })

    // Não é erro de quem pediu: o relatório continua inteiro em tela.
    expect(response.statusCode).toBe(503)
    expect(response.json().code).toBe('ERR_LEDGER_013')
  })
})

/** A data ISO de um instante no fuso do estabelecimento dos testes. */
function isoIn(instant: Date): string {
  return instant.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}
