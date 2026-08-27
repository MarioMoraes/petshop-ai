import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenPet,
  givenProfessional,
  givenService,
  givenTenant,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * O encaixe — AC-03 de MOD-PRONT-01.
 *
 * O pet chegou sem hora marcada. O agendamento nasce retroativo e já concluído, para
 * que a agenda, o caixa e o prontuário contem a mesma história do dia — hoje um
 * atendimento assim simplesmente não existiria em lugar nenhum.
 */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

async function scenario() {
  const serviceId = await givenService(tenant, { priceCents: 9000 })
  const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
  const { petId, tutorId } = await givenPet(tenant)
  return { serviceId, professionalId, petId, tutorId }
}

describe('MOD-PRONT-01 AC-03 — encaixe', () => {
  it('cria o agendamento retroativo já concluído, com origem WALK_IN', async () => {
    const { serviceId, professionalId, petId } = await scenario()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/appointments/walk-in',
      payload: {
        petId,
        professionalId,
        items: [{ serviceId }],
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      status: 'COMPLETED',
      source: 'WALK_IN',
      totalCents: 9000,
    })

    // O intervalo termina agora: o serviço acabou de acontecer.
    const appointment = response.json()
    expect(new Date(appointment.endsAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
    expect(new Date(appointment.startsAt).getTime()).toBeLessThan(
      new Date(appointment.endsAt).getTime(),
    )
  })

  it('a trilha de estado registra a entrada e o fechamento', async () => {
    const { serviceId, professionalId, petId } = await scenario()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/appointments/walk-in',
      payload: {
        petId,
        professionalId,
        items: [{ serviceId }],
        idempotencyKey: randomUUID(),
      },
    })

    const log = await withTenant(tenant.tenantId, (tx) =>
      tx.appointmentStatusLog.findMany({
        where: { appointmentId: response.json().id },
        orderBy: { createdAt: 'asc' },
        select: { fromStatus: true, toStatus: true },
      }),
    )

    expect(log).toEqual([
      { fromStatus: 'CONFIRMED', toStatus: 'CHECKED_IN' },
      { fromStatus: 'CHECKED_IN', toStatus: 'COMPLETED' },
    ])
  })

  it('AC-04: profissional não habilitado no serviço é recusado', async () => {
    const serviceId = await givenService(tenant)
    // Sem `serviceIds`: o profissional existe, mas não executa este serviço.
    const professionalId = await givenProfessional(tenant, { serviceIds: [] })
    const { petId } = await givenPet(tenant)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/appointments/walk-in',
      payload: {
        petId,
        professionalId,
        items: [{ serviceId }],
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('não roda checagem de jornada: o pet já foi atendido, e recusar agora não desfaz o banho', async () => {
    const serviceId = await givenService(tenant)
    // Jornada só na segunda de manhã — qualquer outro instante estaria fora dela.
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      windows: [{ weekday: 1, startsAtMin: 480, endsAtMin: 540 }],
    })
    const { petId } = await givenPet(tenant)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/appointments/walk-in',
      payload: {
        petId,
        professionalId,
        items: [{ serviceId }],
        idempotencyKey: randomUUID(),
      },
    })

    expect(response.statusCode).toBe(201)
  })

  it('o encaixe não é agendável pela porta da frente: `source: WALK_IN` é recusado', async () => {
    const { serviceId, professionalId, petId } = await scenario()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/appointments',
      payload: {
        petId,
        professionalId,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        items: [{ serviceId }],
        source: 'WALK_IN',
      },
    })

    expect(response.statusCode).toBe(422)
  })
})
