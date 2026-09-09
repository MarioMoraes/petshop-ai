import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  enableTaxi,
  givenAppointment,
  givenDriver,
  givenTenant,
  givenTutor,
  givenVehicle,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/** MOD-TAXI-01, 02, 03 e 05 — a corrida, o endereço, o motorista e a cobrança. */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

/** Janelas coerentes com um agendamento que começa daqui a 24h. */
function windows(startsAt: Date, endsAt: Date) {
  return {
    pickup: {
      windowStartsAt: new Date(startsAt.getTime() - 90 * 60_000).toISOString(),
      windowEndsAt: new Date(startsAt.getTime() - 30 * 60_000).toISOString(),
    },
    dropoff: {
      windowStartsAt: new Date(endsAt.getTime() + 30 * 60_000).toISOString(),
      windowEndsAt: new Date(endsAt.getTime() + 90 * 60_000).toISOString(),
    },
  }
}

describe('MOD-TAXI-01 — solicitação e pernas', () => {
  it('AC-01: ida e volta viram duas corridas presas ao mesmo agendamento', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          { leg: 'PICKUP', ...w.pickup },
          { leg: 'DROPOFF', ...w.dropoff },
        ],
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json() as { items: { leg: string; status: string }[] }
    expect(body.items).toHaveLength(2)
    expect(body.items.map((item) => item.leg)).toEqual(['PICKUP', 'DROPOFF'])
    // Sem motorista informado, nasce na fila sem dono (AC-05 de MOD-TAXI-03).
    expect(body.items.every((item) => item.status === 'REQUESTED')).toBe(true)
  })

  it('AC-03: a coleta não pode terminar depois do início do atendimento', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          {
            leg: 'PICKUP',
            windowStartsAt: new Date(appointment.startsAt.getTime() + 30 * 60_000).toISOString(),
            windowEndsAt: new Date(appointment.startsAt.getTime() + 60 * 60_000).toISOString(),
          },
        ],
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_TAXI_003')
  })

  it('AC-04: a segunda ida do mesmo agendamento é recusada', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const payload = {
      appointmentId: appointment.appointmentId,
      legs: [{ leg: 'PICKUP', ...w.pickup }],
    }

    expect((await callApi({ ...asAdmin(tenant), method: 'POST', url: '/v1/taxi/rides', payload })).statusCode).toBe(201)

    const second = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload,
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('ERR_TAXI_004')
    expect(second.json().existingRide).toBeDefined()
  })

  it('AC-05: só a volta é aceito — ida e volta não é pacote indivisível', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'DROPOFF', ...w.dropoff }],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().items).toHaveLength(1)
  })

  it('RN-22: com o Taxi Dog desligado, a API recusa', async () => {
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup }],
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_014')
  })

  it('não aceita corrida em agendamento concluído — o débito já foi para o ledger', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant, { status: 'COMPLETED' })
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup }],
      },
    })

    expect(response.statusCode).toBe(422)
  })
})

describe('MOD-TAXI-02 — endereço', () => {
  it('AC-01: sem endereço informado, herda o primário do tutor e o decifra na resposta', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup }],
      },
    })

    expect(response.statusCode).toBe(201)
    const [ride] = response.json().items as {
      address: { street: string; number: string; accessNotes: string; zipCode: string }
    }[]
    expect(ride?.address.street).toBe('Rua das Acácias')
    expect(ride?.address.number).toBe('120')
    // AC-04: a instrução de acesso é o que decide entre entregar e voltar vazio.
    expect(ride?.address.accessNotes).toBe('Portão azul, interfone 12')
  })

  it('AC-02: o endereço da vez não toca o cadastro do tutor', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          {
            leg: 'PICKUP',
            ...w.pickup,
            address: {
              zipCode: '01001000',
              street: 'Praça da Sé',
              number: '1',
              district: 'Sé',
              city: 'São Paulo',
              state: 'SP',
            },
          },
        ],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().items[0].address.street).toBe('Praça da Sé')

    const addresses = await withTenant(tenant.tenantId, (tx) =>
      tx.tutorAddress.findMany({ where: { tutorId: appointment.tutorId } }),
    )
    expect(addresses).toHaveLength(1)
    expect(addresses[0]?.zipCode).toBe('04567000')
  })

  it('AC-03: tutor sem endereço e sem endereço informado é recusado', async () => {
    await enableTaxi(tenant)
    const tutorId = await givenTutor(tenant, { withAddress: false })
    const appointment = await givenAppointment(tenant, { tutorId })
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup }],
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_TAXI_005')
  })
})

describe('MOD-TAXI-05 — a cobrança pega carona no agendamento', () => {
  it('AC-01: cada perna vira um item com duração zero e soma no total', async () => {
    await enableTaxi(tenant, { defaultPriceCents: 2000 })
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          { leg: 'PICKUP', ...w.pickup },
          { leg: 'DROPOFF', ...w.dropoff },
        ],
      },
    })
    expect(response.statusCode).toBe(201)

    const { items, updated } = await withTenant(tenant.tenantId, async (tx) => ({
      items: await tx.appointmentItem.findMany({
        where: { appointmentId: appointment.appointmentId },
        orderBy: { createdAt: 'asc' },
      }),
      updated: await tx.appointment.findUniqueOrThrow({
        where: { id: appointment.appointmentId },
        select: { totalCents: true, endsAt: true },
      }),
    }))

    // Banho + duas pernas.
    expect(items).toHaveLength(3)
    const taxiItems = items.filter((item) => item.durationMin === 0)
    expect(taxiItems).toHaveLength(2)
    expect(taxiItems.map((item) => Number(item.priceCents))).toEqual([2000, 2000])

    // 8000 do banho + 2000 + 2000.
    expect(Number(updated.totalCents)).toBe(12000)
    // RN-06: a janela do banhista não se mexeu.
    expect(updated.endsAt.getTime()).toBe(appointment.endsAt.getTime())
  })

  it('AC-02: sem serviço de categoria TAXI no catálogo, recusa antes de criar', async () => {
    // Liga o módulo à força, sem serviço — o que o PATCH de settings impediria.
    await withTenant(tenant.tenantId, async (tx) => {
      await tx.taxiSettings.create({
        data: { tenantId: tenant.tenantId, enabled: true, defaultPriceCents: BigInt(2000) },
      })
    })
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup }],
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_TAXI_010')

    // Nada ficou para trás: a transação inteira voltou.
    const rides = await withTenant(tenant.tenantId, (tx) => tx.taxiRide.count())
    expect(rides).toBe(0)
  })

  it('AC-04 de MOD-TAXI-06: preço manual exige `taxi:configure`', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const payload = {
      appointmentId: appointment.appointmentId,
      legs: [
        {
          leg: 'PICKUP',
          ...w.pickup,
          priceCentsOverride: 500,
          priceOverrideReason: 'Combinado no balcão',
        },
      ],
    }

    const denied = await callApi({
      ...(await asReceptionist(tenant)),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload,
    })
    expect(denied.statusCode).toBe(422)

    const allowed = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload,
    })
    expect(allowed.statusCode).toBe(201)
    expect(allowed.json().items[0].priceCents).toBe(500)
    expect(allowed.json().items[0].priceSource).toBe('MANUAL')

    // §9: a justificativa vira trilha.
    const audit = await ownerPrisma.auditLog.findMany({
      where: { tenantId: tenant.tenantId, action: 'taxi_ride.price_overridden' },
    })
    expect(audit).toHaveLength(1)
  })
})

describe('MOD-TAXI-03 — motorista e veículo', () => {
  it('AC-01: com motorista na criação, a corrida já nasce atribuída', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup, driverId }],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().items[0].status).toBe('ASSIGNED')
    expect(response.json().items[0].timestamps.assignedAt).not.toBeNull()
  })

  it('AC-02: motorista sem jornada na janela é recusado, com alternativas no corpo', async () => {
    await enableTaxi(tenant)
    const semJornada = await givenDriver(tenant, { name: 'Pedro', noSchedule: true })
    await givenDriver(tenant, { name: 'João' })
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const created = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup }],
      },
    })
    const rideId = created.json().items[0].id as string

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/assign`,
      payload: { driverId: semJornada },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_006')
    expect(response.json().reason).toBe('OUT_OF_SCHEDULE')
    // A negação oferece quem **pode** ir — senão a recepção volta para o WhatsApp.
    expect(response.json().available).toHaveLength(1)
    expect(response.json().available[0].displayName).toBe('João')
  })

  it('AC-03: a van cheia recusa a próxima corrida sobreposta', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant, { capacity: 2 })
    const w0 = windows(
      new Date(Date.now() + 24 * 3_600_000),
      new Date(Date.now() + 25 * 3_600_000),
    )

    // Três agendamentos distintos, janelas de coleta sobrepostas.
    for (let i = 0; i < 2; i += 1) {
      const appointment = await givenAppointment(tenant)
      const response = await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/taxi/rides',
        payload: {
          appointmentId: appointment.appointmentId,
          legs: [{ leg: 'PICKUP', ...w0.pickup, driverId }],
        },
      })
      expect(response.statusCode).toBe(201)
    }

    const third = await givenAppointment(tenant)
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: third.appointmentId,
        legs: [{ leg: 'PICKUP', ...w0.pickup, driverId }],
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_007')
    expect(response.json().capacity).toBe(2)
    expect(response.json().occupied).toBe(2)
  })

  it('AC-04: a capacidade efetiva é `min(motorista, veículo)`', async () => {
    await enableTaxi(tenant)
    // Motorista com 4, van com 1: o limite que vale é 1.
    const driverId = await givenDriver(tenant, { capacity: 4 })
    const vehicleId = await givenVehicle(tenant, { capacity: 1 })
    const w0 = windows(
      new Date(Date.now() + 24 * 3_600_000),
      new Date(Date.now() + 25 * 3_600_000),
    )

    const first = await givenAppointment(tenant)
    expect(
      (
        await callApi({
          ...asAdmin(tenant),
          method: 'POST',
          url: '/v1/taxi/rides',
          payload: {
            appointmentId: first.appointmentId,
            legs: [{ leg: 'PICKUP', ...w0.pickup, driverId, vehicleId }],
          },
        })
      ).statusCode,
    ).toBe(201)

    const second = await givenAppointment(tenant)
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: second.appointmentId,
        legs: [{ leg: 'PICKUP', ...w0.pickup, driverId, vehicleId }],
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().capacity).toBe(1)
  })

  it('janelas sequenciais não conflitam — 08:00–09:00 e 09:00–10:00 cabem na mesma van', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant, { capacity: 1 })
    const base = new Date(Date.now() + 48 * 3_600_000)

    const first = await givenAppointment(tenant, { hoursFromNow: 52 })
    expect(
      (
        await callApi({
          ...asAdmin(tenant),
          method: 'POST',
          url: '/v1/taxi/rides',
          payload: {
            appointmentId: first.appointmentId,
            legs: [
              {
                leg: 'PICKUP',
                windowStartsAt: base.toISOString(),
                windowEndsAt: new Date(base.getTime() + 3_600_000).toISOString(),
                driverId,
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(201)

    const second = await givenAppointment(tenant, { hoursFromNow: 52 })
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: second.appointmentId,
        legs: [
          {
            leg: 'PICKUP',
            windowStartsAt: new Date(base.getTime() + 3_600_000).toISOString(),
            windowEndsAt: new Date(base.getTime() + 7_200_000).toISOString(),
            driverId,
          },
        ],
      },
    })

    expect(response.statusCode).toBe(201)
  })

  it('AC-06 de MOD-TAXI-04: reatribuir não retrocede o status', async () => {
    await enableTaxi(tenant)
    const joao = await givenDriver(tenant, { name: 'João' })
    const pedro = await givenDriver(tenant, { name: 'Pedro' })
    const appointment = await givenAppointment(tenant)
    const w = windows(appointment.startsAt, appointment.endsAt)

    const created = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...w.pickup, driverId: joao }],
      },
    })
    const rideId = created.json().items[0].id as string

    // Simula o pet já a bordo: a van do João quebrou com o Thor dentro.
    await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.update({ where: { id: rideId }, data: { status: 'ONBOARD' } }),
    )

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/assign`,
      payload: { driverId: pedro },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().driverId).toBe(pedro)
    // O pet continua onde estava — só mudou de mãos.
    expect(response.json().status).toBe('ONBOARD')

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: tenant.tenantId, action: 'taxi_ride.reassigned' },
    })
    expect(audit).not.toBeNull()
    // §9: o motorista anterior é a primeira pergunta quando algo dá errado.
    expect((audit?.before as { driverId: string }).driverId).toBe(joao)
  })
})
