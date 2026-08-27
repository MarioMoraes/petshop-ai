import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  asDriver,
  asReceptionist,
  callApi,
  closeHarness,
  enableTaxi,
  givenAppointment,
  givenDriver,
  givenTaxiService,
  givenTenant,
  givenUser,
  givenVehicle,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/** MOD-TAXI-06 (zonas e preço), a configuração do módulo e o corte de papel do §9. */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

describe('configuração do módulo', () => {
  it('ligar sem apontar o serviço de cobrança é recusado', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: '/v1/taxi/settings',
      payload: { enabled: true },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toContain('serviço de catálogo')
  })

  it('apontar um serviço que não é da categoria TAXI é recusado', async () => {
    const appointment = await givenAppointment(tenant)
    const banho = await withTenant(tenant.tenantId, (tx) =>
      tx.appointmentItem.findFirstOrThrow({
        where: { appointmentId: appointment.appointmentId },
        select: { serviceId: true },
      }),
    )

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: '/v1/taxi/settings',
      payload: { enabled: true, taxiServiceId: banho.serviceId },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toContain('não é da categoria Taxi Dog')
  })

  it('liga o módulo e devolve os padrões do §4', async () => {
    const serviceId = await givenTaxiService(tenant)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: '/v1/taxi/settings',
      payload: { enabled: true, taxiServiceId: serviceId, defaultPriceCents: 2500 },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.enabled).toBe(true)
    expect(body.defaultPriceCents).toBe(2500)
    // RN-16 e RN-18: as duas políticas nascem desligadas.
    expect(body.chargeFailedPickup).toBe(false)
    expect(body.blockOutsideZones).toBe(false)
    expect(body.defaultWindowMinutes).toBe(60)
  })

  it('a recepção lê a configuração mas não a edita (§9)', async () => {
    await enableTaxi(tenant)

    const read = await callApi({
      ...asReceptionist(tenant),
      method: 'GET',
      url: '/v1/taxi/settings',
    })
    expect(read.statusCode).toBe(200)

    const write = await callApi({
      ...asReceptionist(tenant),
      method: 'PATCH',
      url: '/v1/taxi/settings',
      payload: { defaultPriceCents: 9900 },
    })
    expect(write.statusCode).toBe(403)
  })
})

describe('MOD-TAXI-06 — zonas', () => {
  it('AC-01: a corrida resolve a zona pelo CEP e congela o preço dela', async () => {
    await enableTaxi(tenant, { defaultPriceCents: 2000 })

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/zones',
      payload: { name: 'Zona Sul', zipPrefixes: ['0456'], priceCents: 3000 },
    })

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
            windowStartsAt: new Date(
              appointment.startsAt.getTime() - 90 * 60_000,
            ).toISOString(),
            windowEndsAt: new Date(appointment.startsAt.getTime() - 30 * 60_000).toISOString(),
          },
        ],
      },
    })

    expect(response.statusCode).toBe(201)
    // O tutor do fixture mora em 04567000.
    expect(response.json().items[0].priceCents).toBe(3000)
    expect(response.json().items[0].priceSource).toBe('ZONE')
  })

  it('AC-03: entre prefixos que se contêm, vence o mais longo', async () => {
    await enableTaxi(tenant)
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/zones',
      payload: { name: 'Centro', zipPrefixes: ['0100'], priceCents: 1500 },
    })
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/zones',
      payload: { name: 'Centro Histórico', zipPrefixes: ['010012'], priceCents: 4000 },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/taxi/quote?zipCode=01001250',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().zone.name).toBe('Centro Histórico')
    expect(response.json().priceCents).toBe(4000)
  })

  it('AC-03: prefixo idêntico em duas zonas é recusado na criação', async () => {
    await enableTaxi(tenant)
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/zones',
      payload: { name: 'Centro', zipPrefixes: ['0100'], priceCents: 1500 },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/zones',
      payload: { name: 'Baixo Centro', zipPrefixes: ['0100'], priceCents: 2500 },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_012')
    expect(response.json().conflictingZone.name).toBe('Centro')
  })

  it('AC-02: CEP fora de zona usa o padrão — e bloqueia só com o opt-in ligado', async () => {
    await enableTaxi(tenant, { defaultPriceCents: 2000 })

    const fallback = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/taxi/quote?zipCode=99999000',
    })
    expect(fallback.statusCode).toBe(200)
    expect(fallback.json().priceSource).toBe('DEFAULT')
    expect(fallback.json().priceCents).toBe(2000)

    await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: '/v1/taxi/settings',
      payload: { blockOutsideZones: true },
    })

    const blocked = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/taxi/quote?zipCode=99999000',
    })
    expect(blocked.statusCode).toBe(422)
    expect(blocked.json().code).toBe('ERR_TAXI_011')
  })

  it('zona com corrida não é excluída — só desativada', async () => {
    await enableTaxi(tenant)
    const zone = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/zones',
      payload: { name: 'Zona Sul', zipPrefixes: ['0456'], priceCents: 3000 },
    })
    const zoneId = zone.json().id as string

    const appointment = await givenAppointment(tenant)
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          {
            leg: 'PICKUP',
            windowStartsAt: new Date(
              appointment.startsAt.getTime() - 90 * 60_000,
            ).toISOString(),
            windowEndsAt: new Date(appointment.startsAt.getTime() - 30 * 60_000).toISOString(),
          },
        ],
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/taxi/zones/${zoneId}`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_013')
  })
})

describe('frota', () => {
  it('placa duplicada no mesmo tenant é recusada', async () => {
    await enableTaxi(tenant)
    await givenVehicle(tenant, { plate: 'ABC1D23' })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/vehicles',
      payload: { plate: 'ABC1D23', label: 'Outra van', petCapacity: 3 },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toContain('já está cadastrada')
  })

  it('desativar veículo com corrida em aberto exige reatribuir antes', async () => {
    await enableTaxi(tenant)
    const driverId = await givenDriver(tenant)
    const vehicleId = await givenVehicle(tenant)
    const appointment = await givenAppointment(tenant)

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          {
            leg: 'PICKUP',
            windowStartsAt: new Date(
              appointment.startsAt.getTime() - 90 * 60_000,
            ).toISOString(),
            windowEndsAt: new Date(appointment.startsAt.getTime() - 30 * 60_000).toISOString(),
            driverId,
            vehicleId,
          },
        ],
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/taxi/vehicles/${vehicleId}`,
      payload: { active: false },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_TAXI_013')
  })
})

describe('RN-19 — o motorista opera só as próprias corridas', () => {
  it('a listagem do motorista ignora o `driverId` que ele pedir', async () => {
    await enableTaxi(tenant)
    const joaoUserId = await givenUser(tenant, 'DRIVER')
    const joao = await givenDriver(tenant, { name: 'João', userId: joaoUserId })
    const pedro = await givenDriver(tenant, { name: 'Pedro' })

    for (const driverId of [joao, pedro]) {
      const appointment = await givenAppointment(tenant)
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/taxi/rides',
        payload: {
          appointmentId: appointment.appointmentId,
          legs: [
            {
              leg: 'PICKUP',
              windowStartsAt: new Date(
                appointment.startsAt.getTime() - 90 * 60_000,
              ).toISOString(),
              windowEndsAt: new Date(
                appointment.startsAt.getTime() - 30 * 60_000,
              ).toISOString(),
              driverId,
            },
          ],
        },
      })
    }

    const caller = await asDriver(tenant, joaoUserId)

    // O admin vê as duas.
    const all = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/taxi/rides' })
    expect(all.json().total).toBe(2)

    // O João vê só a dele — mesmo pedindo explicitamente a do Pedro.
    const mine = await callApi({ ...caller, method: 'GET', url: `/v1/taxi/rides?driverId=${pedro}` })
    expect(mine.json().total).toBe(1)
    expect(mine.json().items[0].driverId).toBe(joao)
  })

  it('AC-04 de MOD-TAXI-04: a corrida do colega devolve 404, não 403', async () => {
    await enableTaxi(tenant)
    const joaoUserId = await givenUser(tenant, 'DRIVER')
    await givenDriver(tenant, { name: 'João', userId: joaoUserId })
    const pedro = await givenDriver(tenant, { name: 'Pedro' })

    const appointment = await givenAppointment(tenant)
    const created = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          {
            leg: 'PICKUP',
            windowStartsAt: new Date(
              appointment.startsAt.getTime() - 90 * 60_000,
            ).toISOString(),
            windowEndsAt: new Date(appointment.startsAt.getTime() - 30 * 60_000).toISOString(),
            driverId: pedro,
          },
        ],
      },
    })
    const rideId = created.json().items[0].id as string

    const caller = await asDriver(tenant, joaoUserId)
    const response = await callApi({ ...caller, method: 'GET', url: `/v1/taxi/rides/${rideId}` })

    // 404 e não 403: dizer "existe, mas não é sua" já vaza que a corrida existe.
    expect(response.statusCode).toBe(404)
  })

  it('motorista não cria corrida — quem promete a janela é o balcão', async () => {
    await enableTaxi(tenant)
    const joaoUserId = await givenUser(tenant, 'DRIVER')
    await givenDriver(tenant, { name: 'João', userId: joaoUserId })
    const appointment = await givenAppointment(tenant)
    const caller = await asDriver(tenant, joaoUserId)

    const response = await callApi({
      ...caller,
      method: 'POST',
      url: '/v1/taxi/rides',
      payload: {
        appointmentId: appointment.appointmentId,
        legs: [
          {
            leg: 'PICKUP',
            windowStartsAt: new Date(
              appointment.startsAt.getTime() - 90 * 60_000,
            ).toISOString(),
            windowEndsAt: new Date(appointment.startsAt.getTime() - 30 * 60_000).toISOString(),
          },
        ],
      },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_TAXI_009')
  })
})
