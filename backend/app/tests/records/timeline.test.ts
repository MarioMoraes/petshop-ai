import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  asRoleIn,
  callApi,
  checkoutEvent,
  closeHarness,
  givenAppointment,
  givenTenant,
  resetDatabase,
  type AppointmentFixture,
  type TenantFixture,
} from './fixtures.js'
import { handleAtendimentoConcluido } from '../../src/modules/attendances/consumers.js'

/**
 * MOD-PRONT-02 — a linha do tempo.
 *
 * O que se prova aqui é o que o AC-02 chama de inegociável: o recorte por papel é
 * **servidor**. Um teste que só conferisse a ordenação deixaria passar a versão em
 * que o dado clínico viaja até o navegador do banhista e a UI o esconde.
 */

let tenant: TenantFixture
let appointment: AppointmentFixture

/**
 * O banhista sai da matriz, e não de uma lista escrita aqui.
 *
 * `ROLE_PERMISSIONS.BATHER` concede exatamente `record:read_alerts` e
 * `record:write_notes` — o que este teste pedia à mão. A diferença é que agora a
 * asserção continua verdadeira no dia em que a matriz mudar, em vez de continuar
 * passando contra uma lista congelada.
 */
const asBather = (fixture: TenantFixture) => asRoleIn(fixture, 'BATHER')

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  appointment = await givenAppointment(tenant)
})

afterAll(closeHarness)

describe('MOD-PRONT-02 — linha do tempo', () => {
  it('AC-01: unifica origens diferentes em ordem cronológica decrescente', async () => {
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    await givenAllergy()
    await givenWeight()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline`,
    })

    expect(response.statusCode).toBe(200)
    const kinds = response.json().entries.map((entry: { kind: string }) => entry.kind)
    expect(kinds).toContain('ATTENDANCE')
    expect(kinds).toContain('ALLERGY')
    expect(kinds).toContain('WEIGHT')

    const dates = response
      .json()
      .entries.map((entry: { occurredAt: string }) => entry.occurredAt)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('o rascunho não aparece: o histórico é do que aconteceu, não do que está acontecendo', async () => {
    await withTenant(tenant.tenantId, (tx) =>
      tx.attendance.create({
        data: {
          tenantId: tenant.tenantId,
          petId: appointment.petId,
          tutorId: appointment.tutorId,
          appointmentId: appointment.appointmentId,
          type: 'BATH',
          performedBy: appointment.professionalId,
          startedAt: new Date(),
          status: 'DRAFT',
        },
      }),
    )

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline`,
    })

    expect(response.json().entries).toHaveLength(0)
  })

  it('o atendimento anulado continua na linha, marcado — nunca some', async () => {
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId()

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/attendances/${id}/void`,
      payload: { reason: 'Lançado no pet errado — refeito na ficha certa' },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline`,
    })

    const entry = response
      .json()
      .entries.find((item: { kind: string }) => item.kind === 'ATTENDANCE')
    expect(entry.status).toBe('VOIDED')
    expect(entry.meta.voidReason).toContain('pet errado')
  })

  it('AC-02: o banhista não recebe a reação clínica nem o valor do atendimento', async () => {
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    await givenAllergy()

    const response = await callApi({
      ...(await asBather(tenant)),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline`,
    })

    expect(response.statusCode).toBe(200)
    const entries = response.json().entries as {
      kind: string
      detail: string | null
      meta: Record<string, unknown>
    }[]

    const allergy = entries.find((entry) => entry.kind === 'ALLERGY')
    // A alergia aparece — segurança é de todos. O quadro clínico, não.
    expect(allergy).toBeDefined()
    expect(allergy?.detail).toBeNull()

    const attendance = entries.find((entry) => entry.kind === 'ATTENDANCE')
    expect(attendance?.meta).not.toHaveProperty('totalCents')
  })

  it('AC-02: transferência de titularidade é do prontuário completo, não do operacional', async () => {
    const otherTutor = await withTenant(tenant.tenantId, async (tx) => {
      const tutor = await tx.tutor.create({
        data: {
          tenantId: tenant.tenantId,
          fullName: 'Carlos Lima',
          phoneEncrypted: 'v1:x:x:x',
          phoneHash: `phone-${Math.random()}`,
        },
      })
      await tx.petTransferLog.create({
        data: {
          tenantId: tenant.tenantId,
          petId: appointment.petId,
          fromTutorId: appointment.tutorId,
          toTutorId: tutor.id,
          reason: 'ADOPTION',
        },
      })
      return tutor.id
    })
    expect(otherTutor).toBeTruthy()

    const admin = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline`,
    })
    expect(admin.json().entries.some((e: { kind: string }) => e.kind === 'TRANSFER')).toBe(true)

    const bather = await callApi({
      ...(await asBather(tenant)),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline`,
    })
    expect(bather.json().entries.some((e: { kind: string }) => e.kind === 'TRANSFER')).toBe(false)
  })

  it('pagina por cursor sem repetir nem pular eventos', async () => {
    for (let index = 0; index < 7; index += 1) {
      await givenWeight(10 + index, new Date(Date.now() - index * 86_400_000))
    }

    const first = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline?limit=3`,
    })
    expect(first.json().entries).toHaveLength(3)
    expect(first.json().nextCursor).toBeTruthy()

    const second = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline?limit=3&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    })

    const firstIds = first.json().entries.map((e: { id: string }) => e.id)
    const secondIds = second.json().entries.map((e: { id: string }) => e.id)
    expect(secondIds).toHaveLength(3)
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toHaveLength(0)
  })

  it('filtra por tipo quando o cliente pede', async () => {
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    await givenWeight()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline?kinds=WEIGHT`,
    })

    const kinds = new Set(response.json().entries.map((e: { kind: string }) => e.kind))
    expect([...kinds]).toEqual(['WEIGHT'])
  })

  it('pet de outro tenant não tem linha do tempo alcançável', async () => {
    const other = await givenTenant('Outro Petshop')

    const response = await callApi({
      ...asAdmin(other),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/timeline`,
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('MOD-PRONT-11 — resumo clínico', () => {
  it('reúne alertas, último atendimento e contagem de 12 meses numa chamada', async () => {
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    await givenAllergy('CRITICAL')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/summary`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      petId: appointment.petId,
      attendanceCount12m: 1,
      // Sem MOD-PRONT-08 no ar, "desconhecido" — e não "em dia".
      vaccinationStatus: 'UNKNOWN',
      blockingFlags: ['ALLERGY_CRITICAL'],
    })
    expect(response.json().lastAttendanceAt).toBeTruthy()
  })
})

// ─── Apoio ───────────────────────────────────────────────────────────────────

async function firstAttendanceId(): Promise<string> {
  return withTenant(tenant.tenantId, async (tx) => {
    const row = await tx.attendance.findFirstOrThrow({
      where: { petId: appointment.petId },
      select: { id: true },
    })
    return row.id
  })
}

async function givenAllergy(severity = 'HIGH'): Promise<void> {
  await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: `/v1/pets/${appointment.petId}/allergies`,
    payload: {
      type: 'PRODUCT',
      label: 'Shampoo neutro',
      severity,
      reaction: 'Dermatite severa no dorso',
      diagnosedAt: '2026-02-01',
    },
  })
}

async function givenWeight(weightKg = 12.4, measuredAt = new Date()): Promise<void> {
  await withTenant(tenant.tenantId, async (tx) => {
    await tx.petWeight.create({
      data: {
        tenantId: tenant.tenantId,
        petId: appointment.petId,
        weightKg,
        measuredAt,
      },
    })
  })
}
