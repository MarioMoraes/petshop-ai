import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createManualEntry } from '../src/modules/ledger/entries.js'
import { recordPayment, reversePayment } from '../src/modules/ledger/payments.js'
import {
  actorOf,
  asAdmin,
  asReceptionist,
  balanceOf,
  callApi,
  closeHarness,
  entriesOf,
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

/** Débitos escalonados no tempo, para o FIFO ter uma ordem que faça sentido. */
async function givenDebts(amounts: number[]): Promise<string[]> {
  const ids: string[] = []
  for (const [index, amountCents] of amounts.entries()) {
    const result = await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents,
        category: 'SERVICE',
        description: `Atendimento ${index + 1}`,
        occurredAt: new Date(Date.now() - (amounts.length - index) * 86_400_000).toISOString(),
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )
    ids.push(result.entryId)
  }
  return ids
}

async function openCentsOf(entryId: string): Promise<number> {
  const entries = await entriesOf(tenant, tutorId)
  const entry = entries.find((row) => row.id === entryId)
  if (!entry) throw new Error(`lançamento ${entryId} não encontrado`)
  return Number(entry.amountCents) - Number(entry.settledCents)
}

describe('MOD-LEDGER-03 — registro de pagamento', () => {
  it('AC-01: pagamento exato quita a dívida e zera o saldo', async () => {
    const [debitId] = await givenDebts([15000])
    expect(await balanceOf(tenant, tutorId)).toBe(-15000)

    const response = await callApi({
      method: 'POST',
      url: '/v1/payments',
      ...asReceptionist(tenant),
      payload: {
        tutorId,
        amountCents: 15000,
        method: 'PIX_MANUAL',
        receivedAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(201)
    const payment = response.json()
    expect(payment.status).toBe('RECORDED')
    expect(payment.allocatedCents).toBe(15000)
    expect(payment.allocations).toHaveLength(1)
    expect(payment.allocations[0].allocatedBy).toBe('AUTO_FIFO')

    expect(await balanceOf(tenant, tutorId)).toBe(0)
    expect(await openCentsOf(debitId!)).toBe(0)
  })

  it('AC-02: pagamento parcial quita os mais antigos primeiro e deixa resíduo', async () => {
    const [primeiro, segundo, terceiro] = await givenDebts([10000, 10000, 10000])

    await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 15000,
      method: 'CASH',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })

    // O primeiro quita inteiro, o segundo fica pela metade, o terceiro intocado.
    expect(await openCentsOf(primeiro!)).toBe(0)
    expect(await openCentsOf(segundo!)).toBe(5000)
    expect(await openCentsOf(terceiro!)).toBe(10000)
    expect(await balanceOf(tenant, tutorId)).toBe(-15000)
  })

  it('AC-03: pagamento maior que a dívida deixa o excedente como crédito em conta', async () => {
    await givenDebts([10000])

    await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 20000,
      method: 'PIX_MANUAL',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })

    // RN-07: o sistema não devolve dinheiro. Sobra vira saldo positivo.
    expect(await balanceOf(tenant, tutorId)).toBe(10000)
  })

  it('RN-07: o crédito que sobrou quita automaticamente o próximo débito', async () => {
    await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 20000,
      method: 'PIX_MANUAL',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })
    expect(await balanceOf(tenant, tutorId)).toBe(20000)

    const novo = await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents: 12000,
        category: 'SERVICE',
        description: 'Banho de hoje',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    expect(await balanceOf(tenant, tutorId)).toBe(8000)
    // A invariante que a reconciliação e o extrato dependem: o débito não fica aberto
    // enquanto há crédito solto para pagá-lo.
    expect(await openCentsOf(novo.entryId)).toBe(0)
  })

  it('AC-04: forma de pagamento desabilitada é 422 ERR_LEDGER_003', async () => {
    await callApi({
      method: 'PATCH',
      url: '/v1/billing-settings',
      ...asAdmin(tenant),
      payload: { enabledPaymentMethods: ['CASH', 'PIX_MANUAL'] },
    })

    const response = await callApi({
      method: 'POST',
      url: '/v1/payments',
      ...asReceptionist(tenant),
      payload: {
        tutorId,
        amountCents: 5000,
        method: 'CARD_MACHINE_CREDIT',
        receivedAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_LEDGER_003')
  })

  it('alocação manual quita o débito escolhido, não o mais antigo', async () => {
    const [antigo, recente] = await givenDebts([10000, 10000])

    const response = await callApi({
      method: 'POST',
      url: '/v1/payments',
      ...asAdmin(tenant),
      payload: {
        tutorId,
        amountCents: 10000,
        method: 'CASH',
        receivedAt: new Date().toISOString(),
        allocations: [{ debitEntryId: recente!, amountCents: 10000 }],
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().allocations[0].allocatedBy).toBe('MANUAL')

    expect(await openCentsOf(antigo!)).toBe(10000)
    expect(await openCentsOf(recente!)).toBe(0)
  })

  it('alocação acima do que o débito tem aberto é 409 ERR_LEDGER_009', async () => {
    const [debitId] = await givenDebts([10000])

    const response = await callApi({
      method: 'POST',
      url: '/v1/payments',
      ...asAdmin(tenant),
      payload: {
        tutorId,
        amountCents: 20000,
        method: 'CASH',
        receivedAt: new Date().toISOString(),
        allocations: [{ debitEntryId: debitId!, amountCents: 20000 }],
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_LEDGER_009')
  })
})

describe('MOD-LEDGER-03 AC-05 — pagamento lançado por engano', () => {
  it('reverter reabre os débitos, gera contrapartida e não apaga nada', async () => {
    const [debitId] = await givenDebts([15000])

    const payment = await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 15000,
      method: 'PIX_MANUAL',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })
    expect(await balanceOf(tenant, tutorId)).toBe(0)

    await reversePayment(actorOf(tenant), payment.paymentId, 'Lançado no tutor errado')

    // O débito volta a aberto e o saldo volta a ser dívida.
    expect(await openCentsOf(debitId!)).toBe(15000)
    expect(await balanceOf(tenant, tutorId)).toBe(-15000)

    const detalhe = await callApi({
      method: 'GET',
      url: `/v1/payments/${payment.paymentId}`,
      ...asAdmin(tenant),
    })
    const body = detalhe.json()

    expect(body.status).toBe('REVERSED')
    expect(body.reversalReason).toBe('Lançado no tutor errado')
    expect(body.allocatedCents).toBe(0)
    // "Nada é apagado": a alocação continua lá, marcada.
    expect(body.allocations).toHaveLength(1)
    expect(body.allocations[0].reversedAt).not.toBeNull()

    // Débito original + crédito do pagamento + contrapartida do estorno.
    expect(await entriesOf(tenant, tutorId)).toHaveLength(3)
  })

  it('reverter duas vezes é 409', async () => {
    const payment = await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 5000,
      method: 'CASH',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })
    await reversePayment(actorOf(tenant), payment.paymentId, 'Primeira reversão')

    const response = await callApi({
      method: 'POST',
      url: `/v1/payments/${payment.paymentId}/reverse`,
      ...asAdmin(tenant),
      payload: { reason: 'Segunda reversão' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_LEDGER_004')
  })

  it('RN-25: a recepção não reverte pagamento', async () => {
    const payment = await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 5000,
      method: 'CASH',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })

    const response = await callApi({
      method: 'POST',
      url: `/v1/payments/${payment.paymentId}/reverse`,
      ...asReceptionist(tenant),
      payload: { reason: 'Cliente pediu' },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('Sigilo dos campos livres', () => {
  it('`notes` e `proofUrl` aparecem no detalhe, mas não na listagem', async () => {
    const payment = await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 5000,
      method: 'PIX_MANUAL',
      receivedAt: new Date().toISOString(),
      notes: 'Pagou com o PIX da irmã',
      proofUrl: 'https://exemplo.test/comprovante.png',
      idempotencyKey: randomUUID(),
    })

    const detalhe = await callApi({
      method: 'GET',
      url: `/v1/payments/${payment.paymentId}`,
      ...asAdmin(tenant),
    })
    expect(detalhe.json().notes).toBe('Pagou com o PIX da irmã')
    expect(detalhe.json().proofUrl).toBe('https://exemplo.test/comprovante.png')

    const lista = await callApi({
      method: 'GET',
      url: `/v1/payments?tutorId=${tutorId}`,
      ...asAdmin(tenant),
    })
    expect(lista.json().data).toHaveLength(1)
    expect(lista.json().data[0].notes).toBeUndefined()
    expect(lista.json().data[0].proofUrl).toBeUndefined()
  })
})

describe('RN-04 — idempotência do pagamento', () => {
  it('duplo clique no balcão não cobra duas vezes', async () => {
    await givenDebts([15000])
    const payload = {
      tutorId,
      amountCents: 15000,
      method: 'PIX_MANUAL' as const,
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    }

    const primeira = await callApi({
      method: 'POST',
      url: '/v1/payments',
      ...asAdmin(tenant),
      payload,
    })
    const segunda = await callApi({
      method: 'POST',
      url: '/v1/payments',
      ...asAdmin(tenant),
      payload,
    })

    expect(primeira.statusCode).toBe(201)
    expect(segunda.statusCode).toBe(200)
    expect(segunda.json().id).toBe(primeira.json().id)
    expect(await balanceOf(tenant, tutorId)).toBe(0)
  })
})
