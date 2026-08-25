import { randomUUID } from 'node:crypto'
import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handleAtendimentoConcluido, handlePetObito } from '../src/modules/ledger/consumers.js'
import { expirePackages, purchasePackage } from '../src/modules/ledger/packages.js'
import {
  actorOf,
  asAdmin,
  asReceptionist,
  balanceOf,
  callApi,
  closeHarness,
  entriesOf,
  givenPackage,
  givenPet,
  givenService,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

let tenant: TenantFixture
let tutorId: string
let petId: string
let banhoId: string
let tosaId: string
let packageId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  tutorId = await givenTutor(tenant)
  petId = await givenPet(tenant, tutorId)
  banhoId = await givenService(tenant, 'Banho')
  tosaId = await givenService(tenant, 'Tosa Completa')
  packageId = await givenPackage(tenant, { serviceIds: [banhoId], credits: 4, priceCents: 32000 })
})

afterAll(closeHarness)

function attendance(items: { serviceId: string; label: string; priceCents: number }[]) {
  return {
    tenantId: tenant.tenantId,
    appointmentId: randomUUID(),
    petId,
    tutorId,
    professionalId: randomUUID(),
    items,
    totalCents: items.reduce((sum, item) => sum + item.priceCents, 0),
    weightKg: null,
    timestamp: new Date().toISOString(),
  }
}

async function buy(overrides: Record<string, unknown> = {}) {
  return purchasePackage(
    actorOf(tenant),
    packageId,
    {
      tutorId,
      petId,
      paymentMethod: 'PIX_MANUAL',
      idempotencyKey: randomUUID(),
      ...overrides,
    },
    { canOverridePrice: true },
  )
}

async function purchaseRow(purchaseId: string) {
  return withTenant(tenant.tenantId, (tx) =>
    tx.packagePurchase.findFirstOrThrow({ where: { id: purchaseId } }),
  )
}

describe('MOD-LEDGER-07 AC-01 — compra do pacote', () => {
  it('cria a compra ativa com validade de 90 dias e saldo líquido zero', async () => {
    const response = await callApi({
      method: 'POST',
      url: `/v1/packages/${packageId}/purchases`,
      ...asReceptionist(tenant),
      payload: { tutorId, petId, paymentMethod: 'PIX_MANUAL', idempotencyKey: randomUUID() },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('ACTIVE')
    expect(body.creditsTotal).toBe(4)
    expect(body.creditsUsed).toBe(0)
    expect(body.creditsRemaining).toBe(4)
    expect(body.pricePaidCents).toBe(32000)
    expect(body.petName).toBe('Thor')

    const dias = Math.round(
      (new Date(body.expiresAt).getTime() - new Date(body.purchasedAt).getTime()) / 86_400_000,
    )
    expect(dias).toBe(90)

    // Divergência consciente do AC-01: a venda é o DÉBITO e o pagamento é o CRÉDITO.
    // Só o crédito, como o PRD literalmente descreve, deixaria o tutor com 4 banhos
    // **e** R$ 320 de crédito solto.
    const entries = await entriesOf(tenant, tutorId)
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.category).sort()).toEqual(['PACKAGE_PURCHASE', 'PAYMENT'])
    expect(await balanceOf(tenant, tutorId)).toBe(0)
  })

  it('o débito da venda nasce já quitado pelo pagamento', async () => {
    await buy()

    const entries = await entriesOf(tenant, tutorId)
    const venda = entries.find((entry) => entry.category === 'PACKAGE_PURCHASE')!
    expect(Number(venda.settledCents)).toBe(Number(venda.amountCents))
  })

  it('desconto na venda exige permissão de crédito', async () => {
    const recepcao = await callApi({
      method: 'POST',
      url: `/v1/packages/${packageId}/purchases`,
      ...asReceptionist(tenant),
      payload: {
        tutorId,
        petId,
        paymentMethod: 'CASH',
        priceOverrideCents: 25000,
        idempotencyKey: randomUUID(),
      },
    })
    expect(recepcao.statusCode).toBe(403)

    const admin = await callApi({
      method: 'POST',
      url: `/v1/packages/${packageId}/purchases`,
      ...asAdmin(tenant),
      payload: {
        tutorId,
        petId,
        paymentMethod: 'CASH',
        priceOverrideCents: 25000,
        idempotencyKey: randomUUID(),
      },
    })
    expect(admin.statusCode).toBe(201)
    expect(admin.json().pricePaidCents).toBe(25000)
  })

  it('RN-05: alterar o catálogo depois não mexe na compra já feita', async () => {
    const purchase = await buy()

    await callApi({
      method: 'PATCH',
      url: `/v1/packages/${packageId}`,
      ...asAdmin(tenant),
      payload: { name: '4 Banhos (nova tabela)', priceCents: 45000 },
    })

    const lista = await callApi({
      method: 'GET',
      url: `/v1/tutors/${tutorId}/packages`,
      ...asAdmin(tenant),
    })
    const row = lista.json().data.find((item: { id: string }) => item.id === purchase.purchaseId)

    // O snapshot manda: quem comprou "4 Banhos por R$ 320" continua com isso.
    expect(row.name).toBe('4 Banhos Porte Médio')
    expect(row.pricePaidCents).toBe(32000)
  })
})

describe('MOD-LEDGER-07 AC-02 — consumo do crédito', () => {
  it('atendimento coberto consome 1 crédito e não gera débito em dinheiro', async () => {
    const purchase = await buy()

    await handleAtendimentoConcluido(
      attendance([{ serviceId: banhoId, label: 'Banho', priceCents: 8000 }]),
    )

    const row = await purchaseRow(purchase.purchaseId)
    expect(row.creditsUsed).toBe(1)
    expect(row.status).toBe('ACTIVE')

    // O saldo não se move: o lançamento de resgate vale zero.
    expect(await balanceOf(tenant, tutorId)).toBe(0)

    const entries = await entriesOf(tenant, tutorId)
    const resgate = entries.find((entry) => entry.category === 'PACKAGE_REDEMPTION')!
    expect(Number(resgate.amountCents)).toBe(0)
    expect(resgate.sourceType).toBe('PACKAGE')
    expect(resgate.description).toContain('4 Banhos Porte Médio')
  })

  it('AC-04: serviço fora do pacote gera débito em dinheiro normalmente', async () => {
    const purchase = await buy()

    await handleAtendimentoConcluido(
      attendance([{ serviceId: tosaId, label: 'Tosa Completa', priceCents: 9000 }]),
    )

    expect((await purchaseRow(purchase.purchaseId)).creditsUsed).toBe(0)
    expect(await balanceOf(tenant, tutorId)).toBe(-9000)
  })

  it('atendimento misto: o coberto vira resgate, o resto vira um débito só', async () => {
    await buy()

    await handleAtendimentoConcluido(
      attendance([
        { serviceId: banhoId, label: 'Banho', priceCents: 8000 },
        { serviceId: tosaId, label: 'Tosa Completa', priceCents: 9000 },
      ]),
    )

    const entries = await entriesOf(tenant, tutorId)
    expect(entries.filter((entry) => entry.category === 'PACKAGE_REDEMPTION')).toHaveLength(1)

    const dinheiro = entries.find((entry) => entry.category === 'SERVICE')!
    expect(Number(dinheiro.amountCents)).toBe(9000)
    expect(await balanceOf(tenant, tutorId)).toBe(-9000)
  })

  it('o último crédito leva a compra a CONSUMED', async () => {
    const pequeno = await givenPackage(tenant, {
      name: '1 Banho',
      serviceIds: [banhoId],
      credits: 1,
      priceCents: 9000,
    })
    const purchase = await purchasePackage(
      actorOf(tenant),
      pequeno,
      { tutorId, petId, paymentMethod: 'CASH', idempotencyKey: randomUUID() },
      { canOverridePrice: false },
    )

    await handleAtendimentoConcluido(
      attendance([{ serviceId: banhoId, label: 'Banho', priceCents: 8000 }]),
    )

    const row = await purchaseRow(purchase.purchaseId)
    expect(row.creditsUsed).toBe(1)
    expect(row.status).toBe('CONSUMED')
  })

  it('AC-06: sem crédito restante, o próximo atendimento vira dinheiro', async () => {
    const pequeno = await givenPackage(tenant, {
      name: '1 Banho',
      serviceIds: [banhoId],
      credits: 1,
      priceCents: 9000,
    })
    await purchasePackage(
      actorOf(tenant),
      pequeno,
      { tutorId, petId, paymentMethod: 'CASH', idempotencyKey: randomUUID() },
      { canOverridePrice: false },
    )

    await handleAtendimentoConcluido(
      attendance([{ serviceId: banhoId, label: 'Banho', priceCents: 8000 }]),
    )
    await handleAtendimentoConcluido(
      attendance([{ serviceId: banhoId, label: 'Banho', priceCents: 8000 }]),
    )

    // `credits_used` nunca passa de `credits_total` — o CHECK do banco é a segunda
    // linha de defesa depois do `SELECT … FOR UPDATE`.
    const rows = await withTenant(tenant.tenantId, (tx) => tx.packagePurchase.findMany())
    expect(rows.every((row) => row.creditsUsed <= row.creditsTotal)).toBe(true)
    expect(await balanceOf(tenant, tutorId)).toBe(-8000)
  })

  it('a reentrega do evento não queima um segundo crédito', async () => {
    const purchase = await buy()
    const event = attendance([{ serviceId: banhoId, label: 'Banho', priceCents: 8000 }])

    await handleAtendimentoConcluido(event)
    await handleAtendimentoConcluido(event)

    expect((await purchaseRow(purchase.purchaseId)).creditsUsed).toBe(1)
  })

  it('pacote expirado não cobre nada — o débito sai em dinheiro', async () => {
    const purchase = await buy()
    await withTenant(tenant.tenantId, (tx) =>
      tx.packagePurchase.update({
        where: { id: purchase.purchaseId },
        data: { expiresAt: new Date(Date.now() - 86_400_000) },
      }),
    )

    await handleAtendimentoConcluido(
      attendance([{ serviceId: banhoId, label: 'Banho', priceCents: 8000 }]),
    )

    expect((await purchaseRow(purchase.purchaseId)).creditsUsed).toBe(0)
    expect(await balanceOf(tenant, tutorId)).toBe(-8000)
  })
})

describe('MOD-LEDGER-07 AC-03 — expiração', () => {
  it('o job leva a compra vencida a EXPIRED e os créditos são perdidos', async () => {
    const purchase = await buy()
    await withTenant(tenant.tenantId, (tx) =>
      tx.packagePurchase.update({
        where: { id: purchase.purchaseId },
        data: { expiresAt: new Date(Date.now() - 86_400_000) },
      }),
    )

    const result = await expirePackages()
    expect(result.expired).toBe(1)

    const row = await purchaseRow(purchase.purchaseId)
    expect(row.status).toBe('EXPIRED')
    // RN-08: nada é devolvido, nem em dinheiro, nem como crédito em conta.
    expect(await balanceOf(tenant, tutorId)).toBe(0)
  })

  it('compra dentro da validade não é tocada pelo job', async () => {
    const purchase = await buy()
    const result = await expirePackages()

    expect(result.expired).toBe(0)
    expect((await purchaseRow(purchase.purchaseId)).status).toBe('ACTIVE')
  })
})

describe('MOD-LEDGER-07 AC-05 — pet transferido ou falecido', () => {
  it('óbito suspende o pacote sem reembolso, e o pacote fica com quem pagou', async () => {
    const purchase = await buy()

    await handlePetObito({ tenantId: tenant.tenantId, petId })

    const row = await purchaseRow(purchase.purchaseId)
    expect(row.status).toBe('SUSPENDED')
    expect(row.tutorId).toBe(tutorId)
    expect(await balanceOf(tenant, tutorId)).toBe(0)
  })

  it('reatribuir a outro pet do mesmo tutor reativa o pacote', async () => {
    const purchase = await buy()
    const outroPet = await givenPet(tenant, tutorId, 'Mel')
    await handlePetObito({ tenantId: tenant.tenantId, petId })

    const response = await callApi({
      method: 'PATCH',
      url: `/v1/packages/purchases/${purchase.purchaseId}`,
      ...asAdmin(tenant),
      payload: { petId: outroPet },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('ACTIVE')
    expect(response.json().petId).toBe(outroPet)
  })

  it('reatribuir a pet de outro tutor é recusado', async () => {
    const purchase = await buy()
    const outroTutor = await givenTutor(tenant, 'João')
    const petAlheio = await givenPet(tenant, outroTutor, 'Rex')

    const response = await callApi({
      method: 'PATCH',
      url: `/v1/packages/purchases/${purchase.purchaseId}`,
      ...asAdmin(tenant),
      payload: { petId: petAlheio },
    })

    expect(response.statusCode).toBe(404)
  })

  it('cancelar devolve os créditos não usados como crédito em conta, nunca em dinheiro', async () => {
    const purchase = await buy()
    await handleAtendimentoConcluido(
      attendance([{ serviceId: banhoId, label: 'Banho', priceCents: 8000 }]),
    )

    const response = await callApi({
      method: 'PATCH',
      url: `/v1/packages/purchases/${purchase.purchaseId}`,
      ...asAdmin(tenant),
      payload: { status: 'CANCELLED', reason: 'Cliente mudou de cidade' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('CANCELLED')

    // 3 de 4 créditos não usados: R$ 320 × 3/4 = R$ 240, em conta.
    expect(await balanceOf(tenant, tutorId)).toBe(24000)
  })

  it('cancelar sem justificativa é recusado', async () => {
    const purchase = await buy()

    const response = await callApi({
      method: 'PATCH',
      url: `/v1/packages/purchases/${purchase.purchaseId}`,
      ...asAdmin(tenant),
      payload: { status: 'CANCELLED' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('§9: a recepção vende pacote mas não o cancela', async () => {
    const purchase = await buy()

    const response = await callApi({
      method: 'PATCH',
      url: `/v1/packages/purchases/${purchase.purchaseId}`,
      ...asReceptionist(tenant),
      payload: { status: 'CANCELLED', reason: 'Cliente pediu' },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('Catálogo de pacotes', () => {
  it('lista com nomes de serviço e contagem de compras ativas', async () => {
    await buy()

    const response = await callApi({
      method: 'GET',
      url: '/v1/packages',
      ...asAdmin(tenant),
    })

    const item = response.json().data[0]
    expect(item.name).toBe('4 Banhos Porte Médio')
    expect(item.serviceNames).toEqual(['Banho'])
    expect(item.activePurchases).toBe(1)
  })

  it('desativar o pacote tira da vitrine sem cancelar as compras', async () => {
    const purchase = await buy()

    await callApi({
      method: 'PATCH',
      url: `/v1/packages/${packageId}`,
      ...asAdmin(tenant),
      payload: { active: false },
    })

    const vitrine = await callApi({ method: 'GET', url: '/v1/packages', ...asAdmin(tenant) })
    expect(vitrine.json().data).toHaveLength(0)

    expect((await purchaseRow(purchase.purchaseId)).status).toBe('ACTIVE')

    const venda = await callApi({
      method: 'POST',
      url: `/v1/packages/${packageId}/purchases`,
      ...asAdmin(tenant),
      payload: { tutorId, petId, paymentMethod: 'CASH', idempotencyKey: randomUUID() },
    })
    expect(venda.statusCode).toBe(409)
    expect(venda.json().code).toBe('ERR_LEDGER_007')
  })

  it('§9: a recepção não cria pacote no catálogo', async () => {
    const response = await callApi({
      method: 'POST',
      url: '/v1/packages',
      ...asReceptionist(tenant),
      payload: { name: '10 Banhos', serviceIds: [banhoId], credits: 10, priceCents: 70000 },
    })

    expect(response.statusCode).toBe(403)
  })

  it('pacote com serviço inexistente é recusado', async () => {
    const response = await callApi({
      method: 'POST',
      url: '/v1/packages',
      ...asAdmin(tenant),
      payload: {
        name: 'Pacote fantasma',
        serviceIds: [randomUUID()],
        credits: 4,
        priceCents: 32000,
      },
    })

    expect(response.statusCode).toBe(404)
  })
})
