import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { birthdayKeys, sendBirthdays } from '../../src/modules/crm/birthdays.js'
import {
  closeHarness,
  enableAutomation,
  givenTenant,
  givenTutorWithPet,
  installFakeMessagingPort,
  resetDatabase,
  TEST_TIMEZONE,
  type FakeMessaging,
  type TenantFixture,
} from './fixtures.js'

/** MOD-CRM-06 — aniversário de pet e de tutor. */

let fixture: TenantFixture
let messaging: FakeMessaging

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  messaging = installFakeMessagingPort()
})

afterAll(closeHarness)

/**
 * Nove da manhã em São Paulo, num dia e mês escolhidos.
 *
 * Os testes precisam de um relógio que caia na hora configurada da automação, senão a
 * varredura sai sem fazer nada — e o teste passaria por omissão em vez de por acerto.
 */
function at9am(monthDay: string, year = 2027): Date {
  return new Date(`${year}-${monthDay}T12:00:00Z`)
}

describe('aniversário do pet (AC-01)', () => {
  it('felicita quem faz aniversário hoje, com o nome do pet no texto', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    const tutor = await givenTutorWithPet(fixture, { petBirthDate: '2020-06-15' })

    const summary = await sendBirthdays(at9am('06-15'))

    expect(summary.pets.enqueued).toBe(1)
    const request = messaging.requests[0]!
    expect(request.tutorId).toBe(tutor.tutorId)
    expect(request.petId).toBe(tutor.petId)
    expect(request.templateKey).toBe('birthday_pet')
    expect(request.originType).toBe('PET')
    expect(request.variables['pet.nome']).toMatch(/^Rex /)
  })

  it('não faz nada fora da hora configurada', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    await givenTutorWithPet(fixture, { petBirthDate: '2020-06-15' })

    // 18:00 UTC é 15:00 em São Paulo — não são nove da manhã de ninguém aqui.
    const summary = await sendBirthdays(new Date('2027-06-15T18:00:00Z'))

    expect(summary.pets.tenants).toBe(0)
    expect(messaging.requests).toHaveLength(0)
  })

  it('não faz nada com a automação desligada — e ela nasce desligada', async () => {
    await givenTutorWithPet(fixture, { petBirthDate: '2020-06-15' })

    const summary = await sendBirthdays(at9am('06-15'))

    expect(summary.pets.tenants).toBe(0)
    expect(messaging.requests).toHaveLength(0)
  })

  it('usa a mesma chave nas duas passadas do dia', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    await givenTutorWithPet(fixture, { petBirthDate: '2020-06-15' })

    await sendBirthdays(at9am('06-15'))
    await sendBirthdays(at9am('06-15'))

    expect(new Set(messaging.requests.map((request) => request.dedupeKey)).size).toBe(1)
  })
})

describe('aniversário do pet — os casos que custam caro', () => {
  /** AC-02: a falha mais cara que o módulo pode cometer. */
  it('nunca felicita por um pet falecido', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    await givenTutorWithPet(fixture, { petBirthDate: '2020-06-15', petStatus: 'DECEASED' })

    const summary = await sendBirthdays(at9am('06-15'))

    expect(summary.pets.enqueued).toBe(0)
    expect(messaging.requests).toHaveLength(0)
  })

  /** AC-03: data estimada não é data. */
  it('ignora data de nascimento estimada por padrão', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    await givenTutorWithPet(fixture, {
      petBirthDate: '2020-06-15',
      petBirthPrecision: 'ESTIMATED',
    })

    const summary = await sendBirthdays(at9am('06-15'))

    expect(summary.pets.enqueued).toBe(0)
  })

  it('inclui a estimada quando o petshop pede', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9, includeEstimated: true })
    await givenTutorWithPet(fixture, {
      petBirthDate: '2020-06-15',
      petBirthPrecision: 'ESTIMATED',
    })

    const summary = await sendBirthdays(at9am('06-15'))

    expect(summary.pets.enqueued).toBe(1)
  })

  /** AC-04: 29 de fevereiro. */
  it('felicita o nascido em 29/02 no dia 28, nos anos comuns', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    await givenTutorWithPet(fixture, { petBirthDate: '2020-02-29' })

    // 2027 não é bissexto.
    const summary = await sendBirthdays(at9am('02-28', 2027))

    expect(summary.pets.enqueued).toBe(1)
  })

  it('e no próprio 29 quando o ano é bissexto', async () => {
    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    await givenTutorWithPet(fixture, { petBirthDate: '2020-02-29' })

    // 2028 é bissexto: o dia 28 é do dia 28, e o 29 é de quem nasceu nele.
    const onThe28th = await sendBirthdays(at9am('02-28', 2028))
    expect(onThe28th.pets.enqueued).toBe(0)

    const onThe29th = await sendBirthdays(at9am('02-29', 2028))
    expect(onThe29th.pets.enqueued).toBe(1)
  })

  it('birthdayKeys não empurra o 29 para o 28 em ano bissexto', () => {
    expect(birthdayKeys('2027-02-28')).toEqual([
      { month: 2, day: 28 },
      { month: 2, day: 29 },
    ])
    expect(birthdayKeys('2028-02-28')).toEqual([{ month: 2, day: 28 }])
    expect(birthdayKeys('2027-06-15')).toEqual([{ month: 6, day: 15 }])
  })
})

describe('aniversário do tutor', () => {
  it('felicita o titular sem citar os pets', async () => {
    await enableAutomation(fixture, 'birthday_tutor', { sendHour: 9 })
    const tutor = await givenTutorWithPet(fixture, { tutorBirthDate: '1988-06-15' })

    const summary = await sendBirthdays(at9am('06-15'))

    expect(summary.tutors.enqueued).toBe(1)
    const request = messaging.requests[0]!
    expect(request.tutorId).toBe(tutor.tutorId)
    expect(request.templateKey).toBe('birthday_tutor')
    // Sem `pets.lista`: um tutor sem pet vivo receberia a frase com um buraco.
    expect(request.variables['pets.lista']).toBeUndefined()
  })

  it('não felicita tutor arquivado', async () => {
    await enableAutomation(fixture, 'birthday_tutor', { sendHour: 9 })
    const tutor = await givenTutorWithPet(fixture, { tutorBirthDate: '1988-06-15' })
    await withTenant(fixture.tenantId, (tx) =>
      tx.tutor.update({ where: { id: tutor.tutorId }, data: { status: 'INACTIVE' } }),
    )

    const summary = await sendBirthdays(at9am('06-15'))

    expect(summary.tutors.enqueued).toBe(0)
  })
})

describe('fuso do estabelecimento', () => {
  it('a hora que vale é a do petshop, não a do servidor', async () => {
    // O tenant do harness está em São Paulo (UTC-3): 12:00Z é 09:00 local.
    expect(TEST_TIMEZONE).toBe('America/Sao_Paulo')

    await enableAutomation(fixture, 'birthday_pet', { sendHour: 9 })
    await givenTutorWithPet(fixture, { petBirthDate: '2020-06-15' })

    // 09:00 **UTC** seria 06:00 no petshop — cedo demais.
    const tooEarly = await sendBirthdays(new Date('2027-06-15T09:00:00Z'))
    expect(tooEarly.pets.enqueued).toBe(0)

    const onTime = await sendBirthdays(new Date('2027-06-15T12:00:00Z'))
    expect(onTime.pets.enqueued).toBe(1)
  })
})
