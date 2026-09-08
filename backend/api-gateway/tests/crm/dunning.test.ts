import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runDunning, stepFor } from '../../src/modules/crm/dunning.js'
import {
  closeHarness,
  enableAutomation,
  givenOpenDebt,
  givenTenant,
  givenTutorWithPet,
  installFakeMessagingPort,
  resetDatabase,
  type FakeMessaging,
  type TenantFixture,
} from './fixtures.js'

/** MOD-CRM-08 — a régua de cobrança. */

let fixture: TenantFixture
let messaging: FakeMessaging

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  messaging = installFakeMessagingPort()
})

afterAll(closeHarness)

/** Nove da manhã em São Paulo. */
function at9am(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)
}

describe('escalada (AC-01 e AC-02)', () => {
  it('manda o primeiro aviso a quem está três dias em atraso', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9 })
    const tutor = await givenTutorWithPet(fixture)
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 8000, daysAgo: 3 })

    const summary = await runDunning(at9am())

    expect(summary.enqueued).toBe(1)
    const request = messaging.requests[0]!
    expect(request.tutorId).toBe(tutor.tutorId)
    expect(request.templateKey).toBe('dunning_soft')
    // `LEDGER_ENTRY` é o que permite ao motor revalidar o saldo antes de enviar.
    expect(request.originType).toBe('LEDGER_ENTRY')
    // `Intl` separa o símbolo com espaço **não separável**; comparar com um espaço
    // comum falha por um byte invisível.
    expect(request.variables['financeiro.valor_devido']).toMatch(/^R\$\s80,00$/)
    expect(request.variables['financeiro.dias_atraso']).toBe('3')
  })

  it('cada degrau tem o seu texto, e quem está mais atrasado pula para ele', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9 })

    const recent = await givenTutorWithPet(fixture, { name: 'Ana Recente' })
    await givenOpenDebt(fixture, recent.tutorId, { amountCents: 8000, daysAgo: 4 })

    const older = await givenTutorWithPet(fixture, { name: 'Bruno Antigo' })
    await givenOpenDebt(fixture, older.tutorId, { amountCents: 9000, daysAgo: 12 })

    const oldest = await givenTutorWithPet(fixture, { name: 'Carla Antiga' })
    await givenOpenDebt(fixture, oldest.tutorId, { amountCents: 9000, daysAgo: 45 })

    await runDunning(at9am())

    const byTutor = new Map(
      messaging.requests.map((request) => [request.tutorId, request.templateKey]),
    )
    expect(byTutor.get(recent.tutorId)).toBe('dunning_soft')
    expect(byTutor.get(older.tutorId)).toBe('dunning_firm')
    expect(byTutor.get(oldest.tutorId)).toBe('dunning_final')
  })

  it('não repete o mesmo degrau enquanto a dívida for a mesma', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9 })
    const tutor = await givenTutorWithPet(fixture)
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 8000, daysAgo: 5 })

    await runDunning(at9am())
    await runDunning(at9am())

    // Duas passadas, a mesma chave: quem recusa a segunda é o motor, pelo `dedupeKey`.
    expect(new Set(messaging.requests.map((request) => request.dedupeKey)).size).toBe(1)
  })

  it('ainda não cobra quem deve há um dia', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9 })
    const tutor = await givenTutorWithPet(fixture)
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 8000, daysAgo: 1 })

    const summary = await runDunning(at9am())

    expect(summary.enqueued).toBe(0)
  })
})

describe('os limites da régua', () => {
  /** AC-04: custo social de cobrar troco. */
  it('não cobra valor abaixo do piso', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9, minDebtCents: 2000 })
    const tutor = await givenTutorWithPet(fixture)
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 300, daysAgo: 10 })

    const summary = await runDunning(at9am())

    expect(summary.enqueued).toBe(0)
  })

  it('cobra a partir do piso', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9, minDebtCents: 2000 })
    const tutor = await givenTutorWithPet(fixture)
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 2000, daysAgo: 10 })

    const summary = await runDunning(at9am())

    expect(summary.enqueued).toBe(1)
  })

  it('não cobra quem tem crédito maior que o débito em aberto', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9 })
    // O débito existe e está vencido, mas o saldo é positivo: essa pessoa tem dinheiro
    // com o petshop, e o despacho cancelaria a mensagem de qualquer forma.
    const tutor = await givenTutorWithPet(fixture, { balanceCents: 15_000 })
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 8000, daysAgo: 10 })

    const summary = await runDunning(at9am())

    expect(summary.enqueued).toBe(0)
  })

  it('a régua nasce desligada', async () => {
    const tutor = await givenTutorWithPet(fixture)
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 8000, daysAgo: 30 })

    const summary = await runDunning(at9am())

    expect(summary.tenants).toBe(0)
  })

  it('cobrança não exige consentimento de marketing', async () => {
    await enableAutomation(fixture, 'dunning', { sendHour: 9 })
    // Sem nenhuma linha de consentimento: dívida é execução de contrato, e o texto é
    // TRANSACTIONAL. Exigir opt-in aqui esconderia o inadimplente da cobrança.
    const tutor = await givenTutorWithPet(fixture, { marketing: false })
    await givenOpenDebt(fixture, tutor.tutorId, { amountCents: 8000, daysAgo: 5 })

    const summary = await runDunning(at9am())

    expect(summary.enqueued).toBe(1)
  })
})

describe('stepFor', () => {
  const steps = [
    { days: 3, templateKey: 'dunning_soft' },
    { days: 10, templateKey: 'dunning_firm' },
    { days: 30, templateKey: 'dunning_final' },
  ]

  it('devolve o degrau alcançado, não o seguinte', () => {
    expect(stepFor(steps, 2)).toBeNull()
    expect(stepFor(steps, 3)?.templateKey).toBe('dunning_soft')
    expect(stepFor(steps, 9)?.templateKey).toBe('dunning_soft')
    expect(stepFor(steps, 10)?.templateKey).toBe('dunning_firm')
    expect(stepFor(steps, 400)?.templateKey).toBe('dunning_final')
  })
})
