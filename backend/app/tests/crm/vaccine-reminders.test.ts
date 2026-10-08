import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { sendVaccineReminders } from '../../src/modules/crm/vaccines.js'
import {
  closeHarness,
  givenTenant,
  givenTutorWithPet,
  installFakeMessagingPort,
  ownerPrisma,
  resetDatabase,
  type FakeMessaging,
  type TenantFixture,
} from './fixtures.js'

/**
 * O lembrete da próxima dose (MOD-PRONT-08, AC-01).
 *
 * Nove da manhã em São Paulo de 10/03/2027: é a hora padrão da automação, e a janela
 * padrão (sete dias) vai de 11/03 a 17/03.
 */

const NOVE_DA_MANHA = new Date('2027-03-10T12:00:00Z')

let fixture: TenantFixture
let messaging: FakeMessaging

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  messaging = installFakeMessagingPort()
})

afterAll(closeHarness)

async function givenDose(
  petId: string,
  dose: {
    vaccineKey?: string
    vaccineLabel?: string
    appliedAt: string
    nextDoseAt: string | null
    voided?: boolean
  },
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const row = await tx.vaccination.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        origin: 'EXTERNAL',
        vaccineKey: dose.vaccineKey ?? 'V10',
        vaccineLabel: dose.vaccineLabel ?? 'V10 (Polivalente)',
        appliedAt: new Date(dose.appliedAt),
        nextDoseAt: dose.nextDoseAt ? new Date(dose.nextDoseAt) : null,
        ...(dose.voided
          ? { voidedAt: new Date(), voidReason: 'Lançada no pet errado' }
          : {}),
      },
    })
    return row.id
  })
}

describe('lembrete da próxima dose', () => {
  it('avisa o dono principal da dose que vence dentro da antecedência, sem ninguém ligar nada', async () => {
    const tutor = await givenTutorWithPet(fixture)
    const doseId = await givenDose(tutor.petId, { appliedAt: '2026-03-15', nextDoseAt: '2027-03-15' })

    const summary = await sendVaccineReminders(NOVE_DA_MANHA)

    expect(summary.enqueued).toBe(1)
    expect(messaging.requests[0]).toMatchObject({
      tutorId: tutor.tutorId,
      petId: tutor.petId,
      templateKey: 'vaccine_due',
      dedupeKey: `vaccine_due:${doseId}`,
      originType: 'PET',
      variables: { 'vacina.nome': 'V10 (Polivalente)', 'vacina.data': '15/03/2027' },
    })
  })

  it('a mesma dose produz a mesma chave no dia seguinte — quem impede o segundo aviso é ela', async () => {
    const tutor = await givenTutorWithPet(fixture)
    await givenDose(tutor.petId, { appliedAt: '2026-03-15', nextDoseAt: '2027-03-15' })

    await sendVaccineReminders(NOVE_DA_MANHA)
    await sendVaccineReminders(new Date('2027-03-11T12:00:00Z'))

    expect(messaging.requests).toHaveLength(2)
    expect(messaging.requests[0]!.dedupeKey).toBe(messaging.requests[1]!.dedupeKey)
  })

  it('não avisa fora da janela, nem fora da hora', async () => {
    const tutor = await givenTutorWithPet(fixture)
    await givenDose(tutor.petId, { appliedAt: '2026-04-01', nextDoseAt: '2027-04-01' })
    await givenDose(tutor.petId, {
      vaccineKey: 'RABIES',
      vaccineLabel: 'Antirrábica',
      appliedAt: '2026-03-15',
      nextDoseAt: '2027-03-15',
    })

    // 18:00 UTC é 15:00 em São Paulo.
    expect((await sendVaccineReminders(new Date('2027-03-10T18:00:00Z'))).enqueued).toBe(0)

    await sendVaccineReminders(NOVE_DA_MANHA)
    expect(messaging.requests.map((request) => request.variables['vacina.nome'])).toEqual([
      'Antirrábica',
    ])
  })

  it('a antecedência configurada manda na janela', async () => {
    await withTenant(fixture.tenantId, (tx) =>
      tx.automation.create({
        data: {
          tenantId: fixture.tenantId,
          key: 'vaccine_reminder',
          enabled: true,
          config: { sendHour: 9, daysBefore: 2 },
        },
      }),
    )
    const tutor = await givenTutorWithPet(fixture)
    await givenDose(tutor.petId, { appliedAt: '2026-03-15', nextDoseAt: '2027-03-15' })

    expect((await sendVaccineReminders(NOVE_DA_MANHA)).enqueued).toBe(0)
    expect((await sendVaccineReminders(new Date('2027-03-13T12:00:00Z'))).enqueued).toBe(1)
  })

  it('a dose superada, a anulada e a do pet falecido não lembram', async () => {
    const vivo = await givenTutorWithPet(fixture)
    // A de 2026 venceria agora, mas a de março de 2027 já foi dada.
    await givenDose(vivo.petId, { appliedAt: '2026-03-15', nextDoseAt: '2027-03-15' })
    await givenDose(vivo.petId, { appliedAt: '2027-03-01', nextDoseAt: '2028-03-01' })
    await givenDose(vivo.petId, {
      vaccineKey: 'RABIES',
      vaccineLabel: 'Antirrábica',
      appliedAt: '2026-03-14',
      nextDoseAt: '2027-03-14',
      voided: true,
    })

    const falecido = await givenTutorWithPet(fixture, { petStatus: 'DECEASED' })
    await givenDose(falecido.petId, { appliedAt: '2026-03-15', nextDoseAt: '2027-03-15' })

    const summary = await sendVaccineReminders(NOVE_DA_MANHA)

    expect(summary.enqueued).toBe(0)
    expect(messaging.requests).toHaveLength(0)
  })

  it('a automação desligada e a conta suspensa não lembram', async () => {
    const tutor = await givenTutorWithPet(fixture)
    await givenDose(tutor.petId, { appliedAt: '2026-03-15', nextDoseAt: '2027-03-15' })

    await withTenant(fixture.tenantId, (tx) =>
      tx.automation.create({
        data: { tenantId: fixture.tenantId, key: 'vaccine_reminder', enabled: false, config: {} },
      }),
    )
    expect((await sendVaccineReminders(NOVE_DA_MANHA)).enqueued).toBe(0)

    await withTenant(fixture.tenantId, (tx) =>
      tx.automation.update({
        where: { tenantId_key: { tenantId: fixture.tenantId, key: 'vaccine_reminder' } },
        data: { enabled: true },
      }),
    )
    await ownerPrisma.tenant.update({
      where: { id: fixture.tenantId },
      data: { status: 'SUSPENDED' },
    })
    expect((await sendVaccineReminders(NOVE_DA_MANHA)).enqueued).toBe(0)
  })

  it('o plano Starter também lembra — não é campanha', async () => {
    await ownerPrisma.tenant.update({ where: { id: fixture.tenantId }, data: { plan: 'STARTER' } })
    const tutor = await givenTutorWithPet(fixture)
    await givenDose(tutor.petId, { appliedAt: '2026-03-15', nextDoseAt: '2027-03-15' })

    expect((await sendVaccineReminders(NOVE_DA_MANHA)).enqueued).toBe(1)
  })
})
