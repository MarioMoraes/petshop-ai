import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  asDriver,
  callApi,
  closeHarness,
  enableTaxi,
  givenAppointment,
  givenDriver,
  givenTenant,
  givenUser,
  localDayToday,
  localToday,
  resetDatabase,
  type AppointmentFixture,
  type TenantFixture,
} from './fixtures.js'
import {
  handleAgendamentoCancelado,
  handleAgendamentoReagendado,
  handleAtendimentoConcluido,
  handlePetObito,
} from '../../src/modules/taxi/consumers.js'
import { alertUnassignedRides, sweepOverdueRides } from '../../src/modules/taxi/jobs.js'

/** MOD-TAXI-04, 07, 08 e 09 — a execução, o painel, os eventos e a falha. */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function pickupWindow(appointment: AppointmentFixture) {
  return {
    windowStartsAt: new Date(appointment.startsAt.getTime() - 90 * 60_000).toISOString(),
    windowEndsAt: new Date(appointment.startsAt.getTime() - 30 * 60_000).toISOString(),
  }
}

function dropoffWindow(appointment: AppointmentFixture) {
  return {
    windowStartsAt: new Date(appointment.endsAt.getTime() + 30 * 60_000).toISOString(),
    windowEndsAt: new Date(appointment.endsAt.getTime() + 90 * 60_000).toISOString(),
  }
}

/** Cria uma corrida já atribuída e devolve o id. */
async function givenRide(
  appointment: AppointmentFixture,
  driverId: string,
  leg: 'PICKUP' | 'DROPOFF' = 'PICKUP',
): Promise<string> {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/taxi/rides',
    payload: {
      appointmentId: appointment.appointmentId,
      legs: [
        {
          leg,
          ...(leg === 'PICKUP' ? pickupWindow(appointment) : dropoffWindow(appointment)),
          driverId,
        },
      ],
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json().items[0].id as string
}

const advance = (rideId: string, to: string, extra: Record<string, unknown> = {}) =>
  callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: `/v1/taxi/rides/${rideId}/status`,
    payload: { to, ...extra },
  })

describe('MOD-TAXI-04 — máquina de estado', () => {
  it('AC-01: saí, cheguei, peguei o pet, entreguei — com as horas reais', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    for (const to of ['EN_ROUTE', 'ARRIVED', 'ONBOARD', 'DELIVERED']) {
      const response = await advance(rideId, to)
      expect(response.statusCode, `transição para ${to}`).toBe(200)
      expect(response.json().status).toBe(to)
    }

    const ride = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findUniqueOrThrow({ where: { id: rideId } }),
    )
    expect(ride.enRouteAt).not.toBeNull()
    expect(ride.arrivedAt).not.toBeNull()
    expect(ride.onboardAt).not.toBeNull()
    expect(ride.deliveredAt).not.toBeNull()

    // A trilha é append-only e guarda a corrida inteira: criação + 4 transições.
    const log = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRideStatusLog.findMany({ where: { rideId }, orderBy: { recordedAt: 'asc' } }),
    )
    expect(log).toHaveLength(5)
    expect(log.map((row) => row.toStatus)).toEqual([
      'ASSIGNED',
      'EN_ROUTE',
      'ARRIVED',
      'ONBOARD',
      'DELIVERED',
    ])
  })

  it('AC-03: entregar sem ter coletado é recusado', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    await advance(rideId, 'EN_ROUTE')
    await advance(rideId, 'ARRIVED')

    const response = await advance(rideId, 'DELIVERED')
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_008')
    expect(response.json().detail).toContain('Marque a coleta')
  })

  it('AC-05: `occurredAt` retroativo é aceito; futuro e além de 6h não', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    const vinteMinAtras = new Date(Date.now() - 20 * 60_000)
    const ok = await advance(rideId, 'EN_ROUTE', { occurredAt: vinteMinAtras.toISOString() })
    expect(ok.statusCode).toBe(200)

    const ride = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findUniqueOrThrow({ where: { id: rideId } }),
    )
    // A hora informada é a gravada; a do servidor fica em `recorded_at`.
    expect(ride.enRouteAt?.getTime()).toBe(vinteMinAtras.getTime())

    const log = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRideStatusLog.findFirstOrThrow({
        where: { rideId, toStatus: 'EN_ROUTE' },
      }),
    )
    expect(log.occurredAt.getTime()).toBe(vinteMinAtras.getTime())
    expect(log.recordedAt.getTime()).toBeGreaterThan(log.occurredAt.getTime())

    const futuro = await advance(rideId, 'ARRIVED', {
      occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    expect(futuro.statusCode).toBe(422)

    const velho = await advance(rideId, 'ARRIVED', {
      occurredAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
    })
    expect(velho.statusCode).toBe(422)
  })

  it('a trilha de status não pode ser reescrita', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    // São **duas** defesas, e o REVOKE é a que dispara primeiro para a aplicação:
    // `app_user` nem chega ao trigger, porque não tem UPDATE na tabela. O trigger
    // cobre quem conectar como dono — o caminho de uma migration mal escrita ou de
    // alguém no psql de produção.
    await expect(
      withTenant(tenant.tenantId, (tx) =>
        tx.taxiRideStatusLog.updateMany({ where: { rideId }, data: { toStatus: 'DELIVERED' } }),
      ),
    ).rejects.toThrow(/permission denied/i)

    const log = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRideStatusLog.findFirstOrThrow({ where: { rideId } }),
    )
    expect(log.toStatus).toBe('ASSIGNED')
  })

  it('RN-10: a volta não sai antes de o atendimento terminar', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId, 'DROPOFF')

    const cedo = await advance(rideId, 'EN_ROUTE')
    expect(cedo.statusCode).toBe(409)
    expect(cedo.json().detail).toContain('ainda não terminou')

    // O check-out da agenda destrava.
    await handleAtendimentoConcluido({
      tenantId: tenant.tenantId,
      appointmentId: appointment.appointmentId,
    })

    const depois = await advance(rideId, 'EN_ROUTE')
    expect(depois.statusCode).toBe(200)
  })

  it('AC-06 de MOD-TAXI-09: de `ONBOARD` não se cancela', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    await advance(rideId, 'EN_ROUTE')
    await advance(rideId, 'ARRIVED')
    await advance(rideId, 'ONBOARD')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/cancel`,
      payload: { reason: 'TUTOR_REQUEST' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_008')
  })
})

describe('MOD-TAXI-09 — falha e cancelamento', () => {
  it('AC-02: a falha não cancela o agendamento, e por padrão não cobra', async () => {
    await enableTaxi(tenant, { defaultPriceCents: 2000 })
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    await advance(rideId, 'EN_ROUTE')
    await advance(rideId, 'ARRIVED')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/fail`,
      payload: { reason: 'NO_ONE_HOME' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().ride.status).toBe('FAILED')
    // RN-16: porta fechada não se cobra por padrão.
    expect(response.json().chargeRemoved).toBe(true)

    const { appointment: updated, items } = await withTenant(tenant.tenantId, async (tx) => ({
      appointment: await tx.appointment.findUniqueOrThrow({
        where: { id: appointment.appointmentId },
        select: { status: true, totalCents: true },
      }),
      items: await tx.appointmentItem.count({
        where: { appointmentId: appointment.appointmentId },
      }),
    }))

    // RN-13: o atendimento segue de pé — quem decide é a recepção.
    expect(updated.status).toBe('CONFIRMED')
    // Só o banho sobrou; o total voltou aos 8000.
    expect(items).toBe(1)
    expect(Number(updated.totalCents)).toBe(8000)
  })

  it('RN-16: com `charge_failed_pickup` ligado, a falha continua cobrando', async () => {
    await enableTaxi(tenant, { defaultPriceCents: 2000 })
    await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: '/v1/taxi/settings',
      payload: { chargeFailedPickup: true },
    })

    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    await advance(rideId, 'EN_ROUTE')
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/fail`,
      payload: { reason: 'NO_ONE_HOME' },
    })

    expect(response.json().chargeRemoved).toBe(false)
    const total = await withTenant(tenant.tenantId, (tx) =>
      tx.appointment.findUniqueOrThrow({
        where: { id: appointment.appointmentId },
        select: { totalCents: true },
      }),
    )
    expect(Number(total.totalCents)).toBe(10000)
  })

  it('falhar antes de sair é recusado — isso é cancelar', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/fail`,
      payload: { reason: 'NO_ONE_HOME' },
    })

    expect(response.statusCode).toBe(409)
  })

  it('AC-01: cancelar remove o item e devolve o valor ao agendamento', async () => {
    await enableTaxi(tenant, { defaultPriceCents: 2000 })
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/cancel`,
      payload: { reason: 'TUTOR_REQUEST' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().chargeRemoved).toBe(true)

    const total = await withTenant(tenant.tenantId, (tx) =>
      tx.appointment.findUniqueOrThrow({
        where: { id: appointment.appointmentId },
        select: { totalCents: true },
      }),
    )
    expect(Number(total.totalCents)).toBe(8000)
  })

  it('AC-04: cancelada, a mesma perna pode ser pedida de novo', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/cancel`,
      payload: { reason: 'TUTOR_REQUEST' },
    })

    const segunda = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...pickupWindow(appointment) }],
      },
    })

    expect(segunda.statusCode).toBe(201)
  })

  it('motorista registra falha, mas não cancela', async () => {
    await enableTaxi(tenant)
    const joaoUserId = await givenUser(tenant, 'DRIVER')
    const driverId = await givenDriver(tenant, { userId: joaoUserId })
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)
    const caller = await asDriver(tenant, joaoUserId)

    await callApi({
      ...caller,
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/status`,
      payload: { to: 'EN_ROUTE' },
    })

    const falha = await callApi({
      ...caller,
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/fail`,
      payload: { reason: 'WRONG_ADDRESS' },
    })
    expect(falha.statusCode).toBe(200)

    const cancelamento = await callApi({
      ...caller,
      method: 'POST',
      url: `/v1/taxi/rides/${rideId}/cancel`,
      payload: { reason: 'TUTOR_REQUEST' },
    })
    expect(cancelamento.statusCode).toBe(403)
  })
})

describe('§8 — o que a agenda e o pet contam', () => {
  it('RN-14: o agendamento cancelado leva as corridas junto', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    await givenRide(appointment, driverId, 'PICKUP')
    await givenRide(appointment, driverId, 'DROPOFF')

    await handleAgendamentoCancelado({
      tenantId: tenant.tenantId,
      appointmentId: appointment.appointmentId,
    })

    const rides = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findMany({ where: { appointmentId: appointment.appointmentId } }),
    )
    expect(rides).toHaveLength(2)
    expect(rides.every((ride) => ride.status === 'CANCELLED')).toBe(true)
    expect(rides.every((ride) => ride.cancelReason === 'APPOINTMENT_CANCELLED')).toBe(true)
  })

  it('RN-15: o reagendamento cancela, mas não move a janela', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    await handleAgendamentoReagendado({
      tenantId: tenant.tenantId,
      appointmentId: appointment.appointmentId,
    })

    const ride = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findUniqueOrThrow({ where: { id: rideId } }),
    )
    expect(ride.status).toBe('CANCELLED')
    expect(ride.cancelReason).toBe('APPOINTMENT_RESCHEDULED')
  })

  it('RN-21: o óbito cancela as futuras — e não toca nas que já aconteceram', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const futura = await givenAppointment(tenant, { hoursFromNow: 48 })
    const futuraRide = await givenRide(futura, driverId)

    // Uma corrida já entregue, do mesmo pet.
    const entregue = await givenAppointment(tenant, { tutorId: futura.tutorId })
    const entregueRide = await givenRide(entregue, driverId)
    await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.update({
        where: { id: entregueRide },
        data: { status: 'DELIVERED', windowStartsAt: new Date(Date.now() - 3_600_000) },
      }),
    )

    const petId = (
      await withTenant(tenant.tenantId, (tx) =>
        tx.taxiRide.findUniqueOrThrow({ where: { id: futuraRide }, select: { petId: true } }),
      )
    ).petId

    await handlePetObito({ tenantId: tenant.tenantId, petId })

    const rides = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findMany({ where: { id: { in: [futuraRide, entregueRide] } } }),
    )
    const byId = new Map(rides.map((ride) => [ride.id, ride]))
    expect(byId.get(futuraRide)?.status).toBe('CANCELLED')
    expect(byId.get(futuraRide)?.cancelReason).toBe('PET_DECEASED')
    // O passado fica como está.
    expect(byId.get(entregueRide)?.status).toBe('DELIVERED')
  })

  it('o consumo repetido do mesmo evento é inócuo', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    await givenRide(appointment, driverId, 'DROPOFF')

    const event = { tenantId: tenant.tenantId, appointmentId: appointment.appointmentId }
    await handleAtendimentoConcluido(event)
    const primeiro = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findFirstOrThrow({ where: { appointmentId: appointment.appointmentId } }),
    )

    await handleAtendimentoConcluido(event)
    const segundo = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findFirstOrThrow({ where: { appointmentId: appointment.appointmentId } }),
    )

    // `ready_at` não é reescrito: o filtro `readyAt: null` é a idempotência.
    expect(segundo.readyAt?.getTime()).toBe(primeiro.readyAt?.getTime())
  })
})

describe('MOD-TAXI-07 — painel e rota', () => {
  it('AC-01: o painel separa a fila sem dono das faixas por motorista', async () => {
    await enableTaxi(tenant)
    const joao = await givenDriver(tenant, { name: 'João' })

    // Horário fixo no meio do dia civil do tenant. Uma janela calculada a partir de
    // "agora + N horas" atravessaria a meia-noite local quando a suíte roda à noite —
    // e o `checkDriverWindow` recusaria, corretamente, porque a jornada é diária.
    const comDono = await givenAppointment(tenant, { startsAt: localDayToday(10) })
    await givenRide(comDono, joao)
    const semDono = await givenAppointment(tenant, { startsAt: localDayToday(14) })
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: semDono.appointmentId,
        legs: [{ leg: 'PICKUP', ...pickupWindow(semDono) }],
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/taxi/board?date=${localToday()}`,
    })

    expect(response.statusCode).toBe(200)
    const board = response.json()
    expect(board.totals.rides).toBe(2)
    expect(board.unassigned).toHaveLength(1)
    expect(board.lanes).toHaveLength(1)
    expect(board.lanes[0].displayName).toBe('João')
  })

  it('AC-02: a rota traz nome do pet, telefone do tutor e alerta de manuseio', async () => {
    await enableTaxi(tenant)
    const joaoUserId = await givenUser(tenant, 'DRIVER')
    const driverId = await givenDriver(tenant, { userId: joaoUserId })
    const appointment = await givenAppointment(tenant, { startsAt: localDayToday(10) })
    await givenRide(appointment, driverId)

    // O pet morde: é o que o motorista precisa saber antes de abrir a van.
    await withTenant(tenant.tenantId, (tx) =>
      tx.temperament.create({
        data: {
          tenantId: tenant.tenantId,
          petId: appointment.petId,
          classification: 'AGGRESSIVE',
          requiresMuzzle: true,
          requiresTwoHandlers: true,
        },
      }),
    )

    const caller = await asDriver(tenant, joaoUserId)
    const response = await callApi({ ...caller, method: 'GET', url: '/v1/taxi/my-route' })

    expect(response.statusCode).toBe(200)
    const [stop] = response.json().stops
    expect(stop.petName).toBe('Thor')
    expect(stop.tutorName).toBe('Ana Souza')
    expect(stop.tutorPhone).not.toBeNull()
    expect(stop.requiresMuzzle).toBe(true)
    expect(stop.requiresTwoHandlers).toBe(true)
    expect(stop.alerts.some((a: { kind: string }) => a.kind === 'TEMPERAMENT')).toBe(true)
    // O endereço chega decifrado — sem ele o motorista não entrega nada.
    expect(stop.address.street).toBe('Rua das Acácias')
  })

  it('AC-03: a volta ainda travada aparece marcada, não escondida', async () => {
    await enableTaxi(tenant)
    const joaoUserId = await givenUser(tenant, 'DRIVER')
    const driverId = await givenDriver(tenant, { userId: joaoUserId })
    const appointment = await givenAppointment(tenant, { startsAt: localDayToday(10) })
    await givenRide(appointment, driverId, 'DROPOFF')

    const caller = await asDriver(tenant, joaoUserId)
    const response = await callApi({ ...caller, method: 'GET', url: '/v1/taxi/my-route' })

    expect(response.json().stops).toHaveLength(1)
    expect(response.json().stops[0].waitingForAttendance).toBe(true)
  })

  it('o painel não é do motorista; a rota não é do admin sem cadastro', async () => {
    await enableTaxi(tenant)
    const joaoUserId = await givenUser(tenant, 'DRIVER')
    await givenDriver(tenant, { userId: joaoUserId })
    const caller = await asDriver(tenant, joaoUserId)

    expect((await callApi({ ...caller, method: 'GET', url: '/v1/taxi/board' })).statusCode).toBe(
      403,
    )
    // O admin não é motorista cadastrado — usa o painel, que agrupa por motorista.
    expect(
      (await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/taxi/my-route' })).statusCode,
    ).toBe(404)
  })
})

describe('§10 — os jobs relatam, não decidem', () => {
  it('`unassigned-alert` encontra a corrida órfã dentro do horizonte', async () => {
    await enableTaxi(tenant)
    const appointment = await givenAppointment(tenant, { hoursFromNow: 6 })
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [{ leg: 'PICKUP', ...pickupWindow(appointment) }],
      },
    })

    const result = await alertUnassignedRides()
    expect(result.pending).toBe(1)
  })

  it('`overdue-sweeper` conta a janela vencida sem mexer no status', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const appointment = await givenAppointment(tenant)
    const rideId = await givenRide(appointment, driverId)

    await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.update({
        where: { id: rideId },
        data: {
          windowStartsAt: new Date(Date.now() - 7_200_000),
          windowEndsAt: new Date(Date.now() - 3_600_000),
        },
      }),
    )

    const result = await sweepOverdueRides()
    expect(result.overdue).toBe(1)

    // O job relata; quem decide se virou falha é o motorista, que está na porta.
    const ride = await withTenant(tenant.tenantId, (tx) =>
      tx.taxiRide.findUniqueOrThrow({ where: { id: rideId } }),
    )
    expect(ride.status).toBe('ASSIGNED')
  })
})
