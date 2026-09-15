import { randomUUID } from 'node:crypto'
import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createManualEntry } from '../../src/modules/ledger/entries.js'
import { financeIndicators } from '../../src/modules/ledger/indicators.js'
import { purchasePackage } from '../../src/modules/ledger/packages.js'
import { recordPayment } from '../../src/modules/ledger/payments.js'
import {
  actorOf,
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  givenPackage,
  givenPet,
  givenService,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * Os indicadores do financeiro no Início.
 *
 * O que merece prova são as três decisões que não aparecem no número: o prazo é
 * ponderado pelo valor e nunca negativo, o resgate de pacote não é recebimento, e o
 * crédito vencido é contado pelo prazo — mesmo antes de o job diário marcar a compra.
 */

const DAY_MS = 86_400_000

let tenant: TenantFixture
let tutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  tutorId = await givenTutor(tenant)
})

afterAll(closeHarness)

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

async function pagar(amountCents: number, daysAgo: number, tutor = tutorId) {
  return recordPayment(actorOf(tenant), {
    tutorId: tutor,
    amountCents,
    method: 'CASH',
    receivedAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    idempotencyKey: randomUUID(),
  })
}

async function comprarPacote(tutor: string, priceCents = 32_000) {
  const serviceId = await givenService(tenant, `Banho ${randomUUID().slice(0, 4)}`)
  const petId = await givenPet(tenant, tutor)
  const packageId = await givenPackage(tenant, { serviceIds: [serviceId], credits: 4, priceCents })
  return purchasePackage(
    actorOf(tenant),
    packageId,
    { tutorId: tutor, petId, paymentMethod: 'PIX_MANUAL', idempotencyKey: randomUUID() },
    { canOverridePrice: true },
  )
}

describe('prazo médio de recebimento', () => {
  it('pondera pelo valor quitado e conta o pagamento antecipado como zero', async () => {
    const outro = await givenTutor(tenant, 'João Adiantado')

    // R$ 100 de um serviço de 20 dias atrás, quitado hoje: 20 dias.
    await debitar(10_000, 20)
    await pagar(10_000, 0)

    // R$ 300 pagos cinco dias antes do serviço: zero dia, e não -5.
    await pagar(30_000, 10, outro)
    await debitar(30_000, 5, outro)

    const result = await financeIndicators(tenant.tenantId, 30)

    expect(result.collection.settledCents).toBe(40_000)
    // (10.000 × 20 + 30.000 × 0) ÷ 40.000
    expect(result.collection.averageDays).toBeCloseTo(5, 1)
  })

  it('sem nada quitado no período, o prazo é nulo e não zero', async () => {
    await debitar(10_000, 3)

    const result = await financeIndicators(tenant.tenantId, 30)
    expect(result.collection).toEqual({ averageDays: null, settledCents: 0 })
  })
})

describe('pacotes', () => {
  it('conta a adesão entre tutores ativos e o crédito vencido pela data, antes do job', async () => {
    const inativo = await givenTutor(tenant, 'Carla Inativa')
    const vencido = await givenTutor(tenant, 'Pedro Vencido')

    await comprarPacote(tutorId)
    await comprarPacote(inativo)
    const perdida = await comprarPacote(vencido, 40_000)

    await withTenant(tenant.tenantId, async (tx) => {
      await tx.tutor.update({ where: { id: inativo }, data: { status: 'INACTIVE' } })
      // Venceu há dois dias com um dos quatro créditos usado, e o job ainda não passou.
      await tx.packagePurchase.update({
        where: { id: perdida.purchaseId },
        data: { expiresAt: new Date(Date.now() - 2 * DAY_MS), creditsUsed: 1 },
      })
    })

    const result = await financeIndicators(tenant.tenantId, 30)

    expect(result.packages).toEqual({ tutorsWithActive: 1, activeTutors: 2 })
    // Três de quatro créditos de um pacote de R$ 400.
    expect(result.expired).toEqual({ purchases: 1, credits: 3, valueCents: 30_000 })
  })

  it('responde pela rota a quem configura o financeiro, e recusa a recepção', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/ledger/reports/indicators?days=30',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ days: 30, packages: { activeTutors: 1 } })

    const negado = await callApi({
      ...(await asReceptionist(tenant)),
      method: 'GET',
      url: '/v1/ledger/reports/indicators',
    })
    expect(negado.statusCode).toBe(403)
  })
})
