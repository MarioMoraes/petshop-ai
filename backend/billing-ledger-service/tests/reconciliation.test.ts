import { randomUUID } from 'node:crypto'
import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createManualEntry } from '../src/modules/ledger/entries.js'
import { recordPayment, reversePayment } from '../src/modules/ledger/payments.js'
import {
  cashflowByMethod,
  receivablesByBucket,
  reconcileAccounts,
} from '../src/modules/ledger/reconciliation.js'
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

let tenant: TenantFixture
let tutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  tutorId = await givenTutor(tenant)
})

afterAll(closeHarness)

async function post(amountCents: number, daysAgo = 0) {
  return createManualEntry(
    actorOf(tenant),
    {
      tutorId,
      direction: 'DEBIT',
      amountCents,
      category: 'SERVICE',
      description: `Atendimento de ${daysAgo} dias atrás`,
      occurredAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    { canCredit: true },
  )
}

/**
 * Corrompe o saldo materializado sem passar por `postEntry`.
 *
 * É exatamente o cenário que o job existe para pegar: alguém escreveu na conta por
 * fora do único caminho autorizado.
 */
async function corromperSaldo(deltaCents: number): Promise<void> {
  await withTenant(tenant.tenantId, (tx) =>
    tx.$executeRaw`
      UPDATE ledger_accounts
         SET balance_cents = balance_cents + ${deltaCents}
       WHERE tenant_id = ${tenant.tenantId}::uuid AND tutor_id = ${tutorId}::uuid
    `,
  )
}

async function needsReview(): Promise<boolean> {
  return withTenant(tenant.tenantId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId },
      select: { needsReview: true },
    })
    return account?.needsReview ?? false
  })
}

describe('MOD-LEDGER-11 — fechamento e consistência', () => {
  it('AC-01: conta consistente passa sem marcar nada', async () => {
    await post(10000)
    await post(5000)

    const result = await reconcileAccounts()

    expect(result.checked).toBe(1)
    expect(result.ok).toBe(1)
    expect(result.divergent).toBe(0)
    expect(await needsReview()).toBe(false)
  })

  it('AC-02: divergência marca `needs_review` e NÃO corrige o saldo', async () => {
    await post(10000)
    await corromperSaldo(500)

    const result = await reconcileAccounts()

    expect(result.divergent).toBe(1)
    expect(result.divergences[0]).toMatchObject({
      tenantId: tenant.tenantId,
      expected: -10000,
      actual: -9500,
    })
    expect(await needsReview()).toBe(true)

    // Correção silenciosa esconderia o bug de origem. O saldo continua errado —
    // de propósito — até alguém investigar.
    const account = await withTenant(tenant.tenantId, (tx) =>
      tx.ledgerAccount.findFirstOrThrow({ where: { tutorId } }),
    )
    expect(Number(account.balanceCents)).toBe(-9500)
  })

  it('a conta marcada continua aceitando lançamentos — não trava para o tenant', async () => {
    await post(10000)
    await corromperSaldo(500)
    await reconcileAccounts()

    const response = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload: {
        tutorId,
        direction: 'DEBIT',
        amountCents: 3000,
        category: 'PRODUCT',
        description: 'Ração vendida com a conta em revisão',
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(201)
  })

  it('a marca sai sozinha quando a conta volta a bater', async () => {
    await post(10000)
    await corromperSaldo(500)
    await reconcileAccounts()
    expect(await needsReview()).toBe(true)

    await corromperSaldo(-500)
    const result = await reconcileAccounts()

    expect(result.ok).toBe(1)
    expect(await needsReview()).toBe(false)
  })

  it('a janela de 24h ignora conta parada', async () => {
    await post(10000)
    await withTenant(tenant.tenantId, (tx) =>
      tx.ledgerAccount.updateMany({
        where: { tutorId },
        data: { lastEntryAt: new Date(Date.now() - 10 * 86_400_000) },
      }),
    )

    expect((await reconcileAccounts()).checked).toBe(0)
    // `windowHours = null` é o modo de auditoria completa, para depois de um incidente.
    expect((await reconcileAccounts(new Date(), null)).checked).toBe(1)
  })

  it('a soma vem da coluna gerada pelo Postgres, não do que a aplicação achou', async () => {
    await post(10000)
    await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'CREDIT',
        amountCents: 4000,
        category: 'DISCOUNT',
        description: 'Desconto concedido',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    const soma = await withTenant(tenant.tenantId, (tx) =>
      tx.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(signed_amount_cents), 0) AS total FROM ledger_entries
      `,
    )

    expect(Number(soma[0]!.total)).toBe(-6000)
    expect((await reconcileAccounts()).ok).toBe(1)
  })
})

describe('Contas a receber por faixa de atraso', () => {
  it('separa 0–30, 30–60 e 60+ dias', async () => {
    await post(10000, 5)
    await post(20000, 45)
    await post(30000, 90)

    const result = await receivablesByBucket(tenant.tenantId)

    expect(result.buckets).toEqual({
      '0_30d': 10000,
      '30_60d': 20000,
      '60d_plus': 30000,
    })
    expect(result.totalCents).toBe(60000)
  })

  it('conta apenas o que está em aberto, não o valor cheio do débito', async () => {
    const debit = await post(10000, 5)
    await withTenant(tenant.tenantId, (tx) =>
      tx.ledgerEntry.update({
        where: { id: debit.entryId },
        data: { settledCents: 6000n },
      }),
    )

    expect((await receivablesByBucket(tenant.tenantId)).totalCents).toBe(4000)
  })

  it('§9: relatório financeiro é do gestor, não do balcão', async () => {
    const response = await callApi({
      method: 'GET',
      url: '/v1/ledger/reports/receivables',
      ...asAdmin(tenant),
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('Entradas por período e forma de pagamento', () => {
  async function pay(amountCents: number, method: 'CASH' | 'PIX_MANUAL', daysAgo = 0) {
    return recordPayment(actorOf(tenant), {
      tutorId,
      amountCents,
      method,
      receivedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
    })
  }

  const HOJE = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) }

  it('soma por forma de pagamento, do maior para o menor', async () => {
    await pay(10_000, 'PIX_MANUAL')
    await pay(5_000, 'PIX_MANUAL')
    await pay(3_000, 'CASH')

    const result = await cashflowByMethod(tenant.tenantId, HOJE.from, HOJE.to)

    expect(result.totalCents).toBe(18_000)
    expect(result.paymentsCount).toBe(3)
    expect(result.byMethod).toEqual([
      { method: 'PIX_MANUAL', totalCents: 15_000, count: 2 },
      { method: 'CASH', totalCents: 3_000, count: 1 },
    ])
  })

  it('conta pelo `received_at`, não pelo registro — o de ontem pertence a ontem', async () => {
    await pay(10_000, 'CASH', 5)

    expect((await cashflowByMethod(tenant.tenantId, HOJE.from, HOJE.to)).totalCents).toBe(0)
  })

  it('dinheiro estornado nunca entrou', async () => {
    const payment = await pay(10_000, 'CASH')
    await pay(4_000, 'PIX_MANUAL')

    await reversePayment(actorOf(tenant), payment.paymentId, 'Lançado no tutor errado')

    const result = await cashflowByMethod(tenant.tenantId, HOJE.from, HOJE.to)
    expect(result.totalCents).toBe(4_000)
    expect(result.paymentsCount).toBe(1)
  })

  it('período sem movimento devolve zero, não erro', async () => {
    const result = await cashflowByMethod(tenant.tenantId, HOJE.from, HOJE.to)

    expect(result).toMatchObject({ totalCents: 0, paymentsCount: 0, byMethod: [] })
  })

  it('a rota usa o dia de hoje no fuso do estabelecimento quando não recebe período', async () => {
    await pay(7_000, 'CASH')

    const response = await callApi({
      method: 'GET',
      url: '/v1/ledger/reports/cashflow',
      ...asAdmin(tenant),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().totalCents).toBe(7_000)
  })

  it('§9: o caixa do estabelecimento é do gestor, não do balcão', async () => {
    const response = await callApi({
      method: 'GET',
      url: '/v1/ledger/reports/cashflow',
      ...asReceptionist(tenant),
    })

    expect(response.statusCode).toBe(403)
  })
})
