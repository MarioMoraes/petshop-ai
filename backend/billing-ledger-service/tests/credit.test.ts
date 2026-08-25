import { randomUUID } from 'node:crypto'
import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { creditCheck, detectOverdue } from '../src/modules/ledger/credit.js'
import { createManualEntry } from '../src/modules/ledger/entries.js'
import { recordPayment } from '../src/modules/ledger/payments.js'
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
 * Limite de crédito e inadimplência (MOD-LEDGER-09).
 *
 * As duas metades olham coisas diferentes: o limite olha **valor**, a inadimplência
 * olha **tempo**. Confundi-las é como o sistema acabava chamando de inadimplente quem
 * tomou banho de manhã e paga na saída.
 */

let tenant: TenantFixture
let tutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  tutorId = await givenTutor(tenant)
})

afterAll(closeHarness)

/** Débito com data controlada — é a idade dele que a inadimplência lê. */
async function givenDebt(amountCents: number, daysAgo = 0) {
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

async function setLimit(creditLimitCents: number | null, overdueDays = 30) {
  await callApi({
    method: 'PATCH',
    url: '/v1/billing-settings',
    ...asAdmin(tenant),
    payload: { creditLimitCents, overdueDays },
  })
}

async function overdueSince(): Promise<Date | null> {
  return withTenant(tenant.tenantId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId },
      select: { overdueSince: true },
    })
    return account?.overdueSince ?? null
  })
}

describe('MOD-LEDGER-09 — credit-check', () => {
  it('AC-01: dentro do limite, permite e avisa do débito', async () => {
    await setLimit(30_000)
    await givenDebt(12_000)

    const result = await creditCheck(actorOf(tenant), tutorId, 8_000)

    expect(result).toMatchObject({
      allowed: true,
      warning: true,
      requiresOverride: false,
      balanceCents: -12_000,
      projectedCents: -20_000,
      limitCents: 30_000,
    })
    expect(result.message).toContain('R$')
    expect(result.message).toContain('120,00')
  })

  it('AC-02: acima do limite, recusa e pede override', async () => {
    await setLimit(10_000)
    await givenDebt(28_000)

    const result = await creditCheck(actorOf(tenant), tutorId, 9_000)

    expect(result).toMatchObject({ allowed: false, requiresOverride: true, warning: true })
    expect(result.message).toContain('acima do limite')
  })

  it('AC-03: limite nulo nunca bloqueia — a política é opt-in', async () => {
    await setLimit(null)
    await givenDebt(500_000)

    const result = await creditCheck(actorOf(tenant), tutorId, 100_000)

    expect(result.allowed).toBe(true)
    expect(result.requiresOverride).toBe(false)
    // O aviso continua: a recepção precisa saber do débito mesmo sem bloqueio.
    expect(result.warning).toBe(true)
    expect(result.limitCents).toBeNull()
  })

  it('conta em dia não gera aviso nenhum', async () => {
    await setLimit(30_000)

    const result = await creditCheck(actorOf(tenant), tutorId, 8_000)

    expect(result).toMatchObject({ allowed: true, warning: false, balanceCents: 0 })
    expect(result.message).toBe('Conta em dia')
  })

  it('saldo positivo é crédito, e crédito nunca dispara aviso nem bloqueio', async () => {
    await setLimit(10_000)
    await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 50_000,
      method: 'PIX_MANUAL',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })

    const result = await creditCheck(actorOf(tenant), tutorId, 8_000)

    expect(result).toMatchObject({ allowed: true, warning: false, balanceCents: 50_000 })
  })

  it('a projeção é o que decide, não o saldo de agora', async () => {
    await setLimit(20_000)
    await givenDebt(15_000)

    // R$ 150 em aberto está dentro; somar R$ 100 estoura.
    expect((await creditCheck(actorOf(tenant), tutorId, 0)).allowed).toBe(true)
    expect((await creditCheck(actorOf(tenant), tutorId, 10_000)).allowed).toBe(false)
  })

  it('a rota responde 200 mesmo bloqueando — quem recusa é o gate da agenda', async () => {
    await setLimit(10_000)
    await givenDebt(28_000)

    const response = await callApi({
      method: 'GET',
      url: `/v1/ledger/accounts/${tutorId}/credit-check?amountCents=9000`,
      ...asReceptionist(tenant),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().allowed).toBe(false)
  })

  it('reporta há quantos dias o débito mais antigo está aberto', async () => {
    await givenDebt(10_000, 45)
    await givenDebt(5_000, 2)

    expect((await creditCheck(actorOf(tenant), tutorId, 0)).overdueDays).toBe(45)
  })
})

describe('MOD-LEDGER-09 AC-04 — o job de inadimplência', () => {
  it('débito mais velho que `overdue_days` marca a conta e publica o evento', async () => {
    await setLimit(null, 30)
    await givenDebt(12_000, 45)

    const result = await detectOverdue()

    expect(result.detected).toBe(1)
    expect(await overdueSince()).not.toBeNull()
  })

  it('débito recente **não** marca — dever hoje não é estar inadimplente', async () => {
    await setLimit(null, 30)
    await givenDebt(12_000, 2)

    expect((await detectOverdue()).detected).toBe(0)
    expect(await overdueSince()).toBeNull()
  })

  it('a quitação limpa a marca, sem intervenção manual (RN-16)', async () => {
    await setLimit(null, 30)
    await givenDebt(12_000, 45)
    await detectOverdue()
    expect(await overdueSince()).not.toBeNull()

    await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 12_000,
      method: 'CASH',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })

    const result = await detectOverdue()
    expect(result.resolved).toBe(1)
    expect(await overdueSince()).toBeNull()
  })

  it('rodar duas vezes não remarca o que já está marcado', async () => {
    await setLimit(null, 30)
    await givenDebt(12_000, 45)

    expect((await detectOverdue()).detected).toBe(1)
    expect((await detectOverdue()).detected).toBe(0)
  })

  it('`overdue_since` é a data do débito, não a da varredura', async () => {
    await setLimit(null, 30)
    const antigo = new Date(Date.now() - 45 * 86_400_000)
    await givenDebt(12_000, 45)

    await detectOverdue()
    const marcado = await overdueSince()

    // Gravar "hoje" zeraria a contagem a cada varredura, e o tutor nunca passaria de
    // um dia de atraso aos olhos do CRM.
    expect(Math.abs((marcado?.getTime() ?? 0) - antigo.getTime())).toBeLessThan(60_000)
  })

  it('respeita o `overdue_days` de cada tenant', async () => {
    await setLimit(null, 60)
    await givenDebt(12_000, 45)

    // 45 dias não passa de um limite de 60.
    expect((await detectOverdue()).detected).toBe(0)

    await setLimit(null, 30)
    expect((await detectOverdue()).detected).toBe(1)
  })

  it('quitação parcial que deixa débito antigo aberto mantém a marca', async () => {
    await setLimit(null, 30)
    await givenDebt(20_000, 45)
    await detectOverdue()

    await recordPayment(actorOf(tenant), {
      tutorId,
      amountCents: 5_000,
      method: 'CASH',
      receivedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    })

    expect((await detectOverdue()).resolved).toBe(0)
    expect(await overdueSince()).not.toBeNull()
  })
})
