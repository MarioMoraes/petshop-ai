import { randomUUID } from 'node:crypto'
import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createManualEntry, reverseEntry } from '../src/modules/ledger/entries.js'
import { handleAtendimentoConcluido } from '../src/modules/ledger/consumers.js'
import {
  actorOf,
  asAdmin,
  asReceptionist,
  balanceOf,
  callApi,
  closeHarness,
  entriesOf,
  givenPet,
  givenTenant,
  givenService,
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

function attendance(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: tenant.tenantId,
    appointmentId: randomUUID(),
    petId: randomUUID(),
    tutorId,
    professionalId: randomUUID(),
    items: [{ serviceId: randomUUID(), label: 'Banho', priceCents: 12000 }],
    totalCents: 12000,
    weightKg: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('MOD-LEDGER-02 — débito automático do atendimento', () => {
  it('AC-01: atendimento concluído de R$ 120,00 vira débito e derruba o saldo', async () => {
    const event = attendance()
    await handleAtendimentoConcluido(event)

    const entries = await entriesOf(tenant, tutorId)
    expect(entries).toHaveLength(1)

    const entry = entries[0]!
    expect(entry.direction).toBe('DEBIT')
    expect(Number(entry.amountCents)).toBe(12000)
    expect(entry.sourceType).toBe('ATTENDANCE')
    expect(entry.sourceId).toBe(event.appointmentId)
    expect(entry.status).toBe('POSTED')
    expect(Number(entry.balanceAfterCents)).toBe(-12000)

    // A coluna gerada pelo Postgres é o que o job de reconciliação soma.
    expect(Number(entry.signedAmountCents)).toBe(-12000)
    expect(await balanceOf(tenant, tutorId)).toBe(-12000)
  })

  it('AC-02: reentrega do mesmo evento não duplica o débito', async () => {
    const event = attendance()
    await handleAtendimentoConcluido(event)

    // O índice único `(tenant, source_type, source_id, direction)` rejeita a segunda
    // inserção. Quem chama o handler direto vê o erro; o consumidor o traduz em ACK.
    await expect(handleAtendimentoConcluido(event)).rejects.toThrow()

    expect(await entriesOf(tenant, tutorId)).toHaveLength(1)
    expect(await balanceOf(tenant, tutorId)).toBe(-12000)
  })

  it('vários itens viram UM débito agregado, não um por serviço', async () => {
    await handleAtendimentoConcluido(
      attendance({
        items: [
          { serviceId: randomUUID(), label: 'Banho', priceCents: 7000 },
          { serviceId: randomUUID(), label: 'Tosa Higiênica', priceCents: 4000 },
          { serviceId: randomUUID(), label: 'Corte de unhas', priceCents: 1000 },
        ],
        totalCents: 12000,
      }),
    )

    const entries = await entriesOf(tenant, tutorId)
    expect(entries).toHaveLength(1)
    expect(Number(entries[0]!.amountCents)).toBe(12000)
    expect(entries[0]!.description).toBe('Banho e mais 2 serviços')
  })
})

describe('MOD-LEDGER-02 — lançamento manual', () => {
  it('AC-03: recepção vende ração de balcão e recebe 201 com o saldo atualizado', async () => {
    const response = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asReceptionist(tenant),
      payload: {
        tutorId,
        direction: 'DEBIT',
        amountCents: 8990,
        category: 'PRODUCT',
        description: 'Ração X 3kg',
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.amountCents).toBe(8990)
    expect(body.balanceAfterCents).toBe(-8990)
    expect(body.sourceType).toBe('MANUAL')
  })

  it('AC-04: valor zero, negativo ou acima do teto é 422 ERR_LEDGER_002', async () => {
    for (const amountCents of [0, -100, 100_000_001]) {
      const response = await callApi({
        method: 'POST',
        url: '/v1/ledger/entries',
        ...asAdmin(tenant),
        payload: {
          tutorId,
          direction: 'DEBIT',
          amountCents,
          category: 'PRODUCT',
          description: 'Tentativa inválida',
          idempotencyKey: randomUUID(),
        },
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().code).toBe('ERR_LEDGER_002')
    }
  })

  it('lançamento com data futura é recusado — o fato ainda não aconteceu', async () => {
    const amanha = new Date(Date.now() + 24 * 3_600_000).toISOString()
    const response = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload: {
        tutorId,
        direction: 'DEBIT',
        amountCents: 5000,
        category: 'PRODUCT',
        description: 'Lançamento do futuro',
        occurredAt: amanha,
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(422)
  })

  it('§9: a recepção lança débito mas não crédito — desconto é do gestor', async () => {
    const payload = {
      tutorId,
      direction: 'CREDIT' as const,
      amountCents: 5000,
      category: 'DISCOUNT' as const,
      description: 'Desconto de fidelidade',
      idempotencyKey: randomUUID(),
    }

    const recepcao = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asReceptionist(tenant),
      payload,
    })
    expect(recepcao.statusCode).toBe(403)
    expect(recepcao.json().code).toBe('ERR_LEDGER_010')

    const admin = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload: { ...payload, idempotencyKey: randomUUID() },
    })
    expect(admin.statusCode).toBe(201)
    expect(await balanceOf(tenant, tutorId)).toBe(5000)
  })
})

describe('RN-04 — idempotência de API', () => {
  it('a mesma chave com o mesmo payload devolve 200 e o mesmo lançamento', async () => {
    const payload = {
      tutorId,
      direction: 'DEBIT' as const,
      amountCents: 8990,
      category: 'PRODUCT' as const,
      description: 'Ração X 3kg',
      idempotencyKey: randomUUID(),
    }

    const primeira = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload,
    })
    const segunda = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload,
    })

    expect(primeira.statusCode).toBe(201)
    expect(segunda.statusCode).toBe(200)
    expect(segunda.json().id).toBe(primeira.json().id)

    // O que importa: o duplo clique não cobrou duas vezes.
    expect(await balanceOf(tenant, tutorId)).toBe(-8990)
    expect(await entriesOf(tenant, tutorId)).toHaveLength(1)
  })

  it('a mesma chave com payload diferente é 409 ERR_LEDGER_012', async () => {
    const idempotencyKey = randomUUID()
    const base = {
      tutorId,
      direction: 'DEBIT' as const,
      category: 'PRODUCT' as const,
      description: 'Ração X 3kg',
      idempotencyKey,
    }

    await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload: { ...base, amountCents: 8990 },
    })
    const divergente = await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload: { ...base, amountCents: 9990 },
    })

    expect(divergente.statusCode).toBe(409)
    expect(divergente.json().code).toBe('ERR_LEDGER_012')
  })
})

describe('MOD-LEDGER-05 — estorno por contrapartida', () => {
  it('gera lançamento inverso vinculado e mantém os dois no extrato', async () => {
    const created = await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents: 5000,
        category: 'SERVICE',
        description: 'Taxa cobrada por engano',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    const result = await reverseEntry(actorOf(tenant), created.entryId, 'Emergência comprovada')

    const entries = await entriesOf(tenant, tutorId)
    expect(entries).toHaveLength(2)

    const original = entries.find((entry) => entry.id === created.entryId)!
    const contrapartida = entries.find((entry) => entry.id === result.reversalEntryId)!

    expect(original.status).toBe('REVERSED')
    expect(original.reversedByEntryId).toBe(contrapartida.id)
    expect(contrapartida.direction).toBe('CREDIT')
    expect(contrapartida.reversesEntryId).toBe(original.id)
    expect(Number(contrapartida.amountCents)).toBe(5000)

    // O par se anula, e o saldo volta ao que era.
    expect(await balanceOf(tenant, tutorId)).toBe(0)
  })

  it('estornar duas vezes é 409 — seria criar dinheiro', async () => {
    const created = await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents: 5000,
        category: 'SERVICE',
        description: 'Serviço lançado por engano',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    await reverseEntry(actorOf(tenant), created.entryId, 'Primeiro estorno')

    const response = await callApi({
      method: 'POST',
      url: `/v1/ledger/entries/${created.entryId}/reverse`,
      ...asAdmin(tenant),
      payload: { reason: 'Segundo estorno' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_LEDGER_004')
  })

  it('RN-25: a recepção não estorna — o balcão registra, o gestor corrige', async () => {
    const created = await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents: 5000,
        category: 'SERVICE',
        description: 'Serviço',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    const response = await callApi({
      method: 'POST',
      url: `/v1/ledger/entries/${created.entryId}/reverse`,
      ...asReceptionist(tenant),
      payload: { reason: 'Cliente reclamou' },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('RN-01 — imutabilidade garantida pelo banco', () => {
  it('o trigger recusa alterar valor, direção ou saldo corrido de um lançamento', async () => {
    const created = await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents: 5000,
        category: 'SERVICE',
        description: 'Serviço',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    // Mesmo com acesso direto ao banco, a aplicação não consegue reescrever o valor:
    // a garantia está no Postgres, não no código que se quer auditar.
    await expect(
      withTenant(tenant.tenantId, (tx) =>
        tx.ledgerEntry.update({
          where: { id: created.entryId },
          data: { amountCents: 1n },
        }),
      ),
    ).rejects.toThrow(/ERR_LEDGER_005/)
  })

  it('a RULE impede DELETE — o lançamento não sai do livro', async () => {
    const created = await createManualEntry(
      actorOf(tenant),
      {
        tutorId,
        direction: 'DEBIT',
        amountCents: 5000,
        category: 'SERVICE',
        description: 'Serviço',
        idempotencyKey: randomUUID(),
      },
      { canCredit: true },
    )

    await withTenant(tenant.tenantId, (tx) =>
      tx.$executeRaw`DELETE FROM ledger_entries WHERE id = ${created.entryId}::uuid`,
    )

    expect(await entriesOf(tenant, tutorId)).toHaveLength(1)
  })
})

describe('RN-17 — conta criada preguiçosamente', () => {
  it('tutor sem movimentação devolve 200 com saldo zero, nunca 404', async () => {
    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}`,
      ...asAdmin(tenant),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tutorId,
      balanceCents: 0,
      openDebitsCents: 0,
      openDebitsCount: 0,
      needsReview: false,
    })
  })

  it('tutor de outro tenant não é alcançável', async () => {
    const outro = await givenTenant('Outro Petshop')
    const outroTutor = await givenTutor(outro, 'Tutor Alheio')

    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${outroTutor}`,
      ...asAdmin(tenant),
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('AC-05 — atendimento coberto por pacote não vira dinheiro', () => {
  it('serviço fora do pacote gera débito normal (RN-10: casa por serviço, não por valor)', async () => {
    const petId = await givenPet(tenant, tutorId)
    const banhoId = await givenService(tenant, 'Banho')
    const tosaId = await givenService(tenant, 'Tosa Completa')

    await callApi({
      method: 'POST',
      url: '/v1/packages',
      ...asAdmin(tenant),
      payload: {
        name: '4 Banhos',
        serviceIds: [banhoId],
        credits: 4,
        priceCents: 32000,
        validityDays: 90,
      },
    })

    // Tosa não está no pacote: o débito em dinheiro sai normalmente.
    await handleAtendimentoConcluido(
      attendance({
        petId,
        items: [{ serviceId: tosaId, label: 'Tosa Completa', priceCents: 9000 }],
        totalCents: 9000,
      }),
    )

    const entries = await entriesOf(tenant, tutorId)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.category).toBe('SERVICE')
    expect(Number(entries[0]!.amountCents)).toBe(9000)
  })
})
