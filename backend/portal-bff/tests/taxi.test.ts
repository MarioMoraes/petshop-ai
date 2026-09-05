import { AppError } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  callApi,
  closeHarness,
  fakeScheduling,
  fakeTaxi,
  givenPet,
  givenProfessional,
  givenService,
  givenTaxiSettings,
  givenTenant,
  givenTutor,
  givenTutorAddress,
  ownerPrisma,
  resetDatabase,
  setSettings,
  type SchedulingDouble,
  type TaxiDouble,
  type TenantFixture,
} from './harness.js'

/**
 * MOD-PORTAL-07 — o leva-e-traz pedido junto do agendamento.
 *
 * A regra do Taxi Dog — zona, preço, capacidade da van, item de cobrança — tem suíte
 * própria no taxidog-service, e repeti-la aqui só criaria dois lugares para consertar.
 * O que **esta** suíte guarda é o que o BFF acrescenta e ninguém mais faz:
 *
 * - a oferta que responde "quanto custa buscar aqui" antes de existir corrida;
 * - a recusa por vaga **antes** de o agendamento nascer, com as alternativas do dia;
 * - o agendamento que sobrevive à falha do transporte;
 * - a janela derivada do atendimento, que o domínio não teria como adivinhar;
 * - o status traduzido para quem não trabalha no petshop.
 */

let fixture: TenantFixture
let scheduling: SchedulingDouble
let taxi: TaxiDouble

/** Amanhã às 14:00 UTC — longe da antecedência mínima e do fim do dia em qualquer fuso. */
function amanha(hora = 14): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + 1)
  date.setUTCHours(hora, 0, 0, 0)
  return date
}

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  scheduling = fakeScheduling(fixture)
  taxi = fakeTaxi(fixture)
  await setSettings(fixture, { onlineBookingEnabled: true })
})

afterAll(async () => {
  await closeHarness()
})

/** O cenário completo: tutor com endereço, pet, serviço com executor e Taxi Dog ligado. */
async function cenario(): Promise<{
  tutorId: string
  petId: string
  serviceId: string
  professionalId: string
}> {
  const tutorId = await givenTutor(fixture)
  await givenTutorAddress(fixture, tutorId)
  const petId = await givenPet(fixture, tutorId)
  const professionalId = await givenProfessional(fixture)
  const serviceId = await givenService(fixture, { name: 'Banho', professionalId })
  await givenTaxiSettings(fixture)

  return { tutorId, petId, serviceId, professionalId }
}

describe('GET /portal/v1/booking/taxi', () => {
  it('devolve o preço da perna e o endereço para onde o motorista iria (AC-02)', async () => {
    const { tutorId } = await cenario()
    taxi.quoteCents = 2500

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/booking/taxi',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      available: boolean
      priceCentsPerLeg: number
      address: { label: string; zipCode: string }
      windowMinutes: number
    }
    expect(body.available).toBe(true)
    expect(body.priceCentsPerLeg).toBe(2500)
    expect(body.address.label).toContain('Avenida Paulista, 1000')
    expect(body.windowMinutes).toBe(60)
    // A cotação é do CEP, e é a única coisa que o BFF pergunta ao domínio para montar a
    // oferta — nada de corrida criada para descobrir preço.
    expect(taxi.calls.quotes).toEqual(['01310100'])
  })

  it('diz que o endereço está fora da área, sem transformar isso em erro (AC-03)', async () => {
    const { tutorId } = await cenario()
    taxi.quoteCents = null

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/booking/taxi',
      ...asTutor(fixture, tutorId),
    })

    // 200 e não 422: o tutor perguntou se dá, e "não dá" é a resposta, não a falha.
    expect(response.statusCode).toBe(200)
    const body = response.json() as { available: boolean; reason: string; message: string }
    expect(body.available).toBe(false)
    expect(body.reason).toBe('OUT_OF_AREA')
    expect(body.message).toContain('fora da área')
  })

  it('sem endereço cadastrado, manda falar com a equipe e não cota nada', async () => {
    const tutorId = await givenTutor(fixture)
    await givenTaxiSettings(fixture)

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/booking/taxi',
      ...asTutor(fixture, tutorId),
    })

    const body = response.json() as { available: boolean; reason: string }
    expect(body.reason).toBe('NO_ADDRESS')
    expect(taxi.calls.quotes).toHaveLength(0)
  })

  it('com o Taxi Dog desligado, a oferta some sem consultar o serviço', async () => {
    const tutorId = await givenTutor(fixture)
    await givenTutorAddress(fixture, tutorId)
    await givenTaxiSettings(fixture, { enabled: false })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/booking/taxi',
      ...asTutor(fixture, tutorId),
    })

    expect((response.json() as { reason: string }).reason).toBe('DISABLED')
    expect(taxi.calls.quotes).toHaveLength(0)
  })

  it('sem o serviço de catálogo que ancora a cobrança, não oferece', async () => {
    const tutorId = await givenTutor(fixture)
    await givenTutorAddress(fixture, tutorId)
    await givenTaxiSettings(fixture, { withService: false })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/booking/taxi',
      ...asTutor(fixture, tutorId),
    })

    expect((response.json() as { reason: string }).reason).toBe('NOT_CONFIGURED')
  })
})

describe('POST /portal/v1/booking com leva-e-traz', () => {
  it('cria o agendamento e duas corridas, com as janelas do atendimento (AC-01)', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    const inicio = amanha()
    scheduling.slots = [{ startsAt: inicio, professionalId, professionalName: 'Ana' }]

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: inicio.toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: true },
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(201)
    const body = response.json() as {
      taxi: { leg: string; statusText: string }[]
      taxiWarning: string | null
    }
    expect(body.taxiWarning).toBeNull()
    expect(body.taxi.map((ride) => ride.leg)).toEqual(['PICKUP', 'DROPOFF'])

    // RN-02 do MOD-TAXI: ida e volta são duas linhas, e é o taxidog quem as cria.
    expect(taxi.calls.created).toHaveLength(1)
    expect(taxi.calls.created[0]!.legs).toEqual(['PICKUP', 'DROPOFF'])

    const rides = await ownerPrisma.taxiRide.findMany({
      where: { tenantId: fixture.tenantId },
      orderBy: { leg: 'asc' },
    })
    const pickup = rides.find((ride) => ride.leg === 'PICKUP')!
    const dropoff = rides.find((ride) => ride.leg === 'DROPOFF')!

    // A coleta termina quando o atendimento começa; a entrega começa quando ele termina.
    // São os limites que o `assertCoherentWindow` do taxidog-service confere.
    expect(pickup.windowEndsAt.toISOString()).toBe(inicio.toISOString())
    expect(inicio.getTime() - pickup.windowStartsAt.getTime()).toBe(60 * 60_000)
    expect(dropoff.windowStartsAt.getTime()).toBe(inicio.getTime() + 60 * 60_000)
  })

  it('pede só a perna marcada', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    const inicio = amanha()

    await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: inicio.toISOString(),
        professionalId,
        taxi: { pickup: false, dropoff: true },
      },
      ...asTutor(fixture, tutorId),
    })

    expect(taxi.calls.created[0]!.legs).toEqual(['DROPOFF'])
  })

  it('recusa antes de criar o agendamento quando a van está cheia (AC-04)', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    const inicio = amanha()
    taxi.remaining = 0
    // A alternativa sai da grade do dia, sondada uma a uma no caminho da recusa.
    scheduling.slots = [
      { startsAt: inicio, professionalId, professionalName: 'Ana' },
      { startsAt: amanha(17), professionalId, professionalName: 'Ana' },
    ]

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: inicio.toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(409)
    const body = response.json() as { code: string; detail: string }
    expect(body.code).toBe('ERR_TAXI_007')
    expect(body.detail).toContain('sem o transporte')

    // "O Portal não enfileira pedido sem vaga": nada foi criado dos dois lados.
    expect(scheduling.calls.created).toHaveLength(0)
    expect(await ownerPrisma.appointment.count({ where: { tenantId: fixture.tenantId } })).toBe(0)
  })

  it('oferece os horários do mesmo dia em que o leva-e-traz ainda cabe (AC-04)', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    const inicio = amanha()
    const outro = amanha(17)
    scheduling.slots = [
      { startsAt: inicio, professionalId, professionalName: 'Ana' },
      { startsAt: outro, professionalId, professionalName: 'Ana' },
    ]

    /**
     * Cheia na primeira pergunta, com vaga na segunda.
     *
     * É o cenário que a alternativa existe para resolver: a van lotou naquela janela, e
     * não no dia inteiro. Sem o contador, o teste não distinguiria "não há alternativa"
     * de "não fomos procurar".
     */
    let consultas = 0
    const original = taxi.remaining
    Object.defineProperty(taxi, 'remaining', {
      get: () => (consultas++ === 0 ? 0 : original),
      configurable: true,
    })

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: inicio.toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(409)
    const body = response.json() as { alternativeStartsAt: string[] }
    expect(body.alternativeStartsAt).toEqual([outro.toISOString()])
  })

  it('marca o horário mesmo quando a corrida é recusada, e avisa (AC-03 e §5)', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    const inicio = amanha()
    taxi.failCreateWith = new AppError('ERR_TAXI_005', 'Endereço de coleta ausente')

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: inicio.toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })

    // Perder o banho por causa do transporte seria o pior desfecho possível.
    expect(response.statusCode).toBe(201)
    const body = response.json() as { id: string; taxi: unknown[]; taxiWarning: string }
    expect(body.taxi).toHaveLength(0)
    expect(body.taxiWarning).toContain('Endereço de coleta ausente')
    expect(await ownerPrisma.appointment.count({ where: { tenantId: fixture.tenantId } })).toBe(1)
  })

  it('fora da área, marca o horário sem o transporte e diz por quê (AC-03)', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    taxi.quoteCents = null

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(201)
    const body = response.json() as { taxiWarning: string }
    expect(body.taxiWarning).toContain('fora da área')
    expect(taxi.calls.created).toHaveLength(0)
  })

  it('não pede corrida nenhuma quando o tutor não marcou a opção', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
        professionalId,
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(201)
    expect((response.json() as { taxi: unknown[] }).taxi).toEqual([])
    expect(taxi.calls.quotes).toHaveLength(0)
    expect(taxi.calls.created).toHaveLength(0)
  })

  it('recusa o pedido sem nenhuma perna marcada', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
        professionalId,
        taxi: { pickup: false, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(422)
  })
})

describe('GET /portal/v1/appointments com leva-e-traz', () => {
  it('mostra o status em texto de cliente e a janela, sem motorista (AC-05)', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    const inicio = amanha()

    await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: inicio.toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/appointments',
      ...asTutor(fixture, tutorId),
    })

    const body = response.json() as {
      upcoming: { taxi: Record<string, unknown>[] }[]
    }
    const ride = body.upcoming[0]!.taxi[0]!

    // "Sem motorista" é a coluna do painel. Aqui a corrida está programada, e é isso que
    // o dono do animal precisa ler.
    expect(ride).toMatchObject({ leg: 'PICKUP', legLabel: 'Buscar', statusText: 'Programado' })
    expect(ride.windowStartsAt).toBeTypeOf('string')
    expect(Object.keys(ride)).not.toContain('driverId')
    expect(JSON.stringify(ride)).not.toContain('Paulista')
  })

  it('a corrida cancelada em cascata não aparece — o agendamento já contou o fato', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()

    const criado = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })
    const appointmentId = (criado.json() as { id: string }).id

    await ownerPrisma.taxiRide.updateMany({
      where: { appointmentId },
      data: { status: 'CANCELLED', cancelReason: 'APPOINTMENT_CANCELLED' },
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/appointments/${appointmentId}`,
      ...asTutor(fixture, tutorId),
    })

    expect((response.json() as { taxi: unknown[] }).taxi).toEqual([])
  })

  it('a corrida de outro tutor nunca entra na lista de quem pergunta', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    const criado = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })
    const appointmentId = (criado.json() as { id: string }).id

    const outro = await givenTutor(fixture, { phone: '+5511911112222' })
    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/appointments/${appointmentId}`,
      ...asTutor(fixture, outro),
    })

    // RN-03: o que não é dele responde 404, exatamente como o que não existe.
    expect(response.statusCode).toBe(404)
  })
})

describe('a taxa de cancelamento não cobra o transporte (AC-06)', () => {
  it('calcula a taxa sobre o serviço, e não sobre o total que inclui a corrida', async () => {
    const { tutorId, petId, serviceId, professionalId } = await cenario()
    await setSettings(fixture, { cancellationWindowHours: 48, noShowFeePercent: 50 })

    const criado = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
        professionalId,
        taxi: { pickup: true, dropoff: false },
      },
      ...asTutor(fixture, tutorId),
    })
    const appointmentId = (criado.json() as { id: string }).id

    /**
     * O item que cobra a corrida, como o taxidog-service o cria (RN-05 do MOD-TAXI):
     * `duration_min = 0` e o valor somado ao total do agendamento.
     */
    const taxiService = await ownerPrisma.service.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, category: 'TAXI' },
      select: { id: true },
    })
    await ownerPrisma.appointmentItem.create({
      data: {
        tenantId: fixture.tenantId,
        appointmentId,
        serviceId: taxiService.id,
        label: 'Taxi Dog — ida',
        priceCents: 2500n,
        durationMin: 0,
      },
    })
    await ownerPrisma.appointment.update({
      where: { id: appointmentId },
      data: { totalCents: { increment: 2500n } },
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/appointments/${appointmentId}`,
      ...asTutor(fixture, tutorId),
    })

    const body = response.json() as {
      totalCents: number
      services: string[]
      actions: { cancelFeeCents: number }
    }

    // O banho custa 8000; 50% dele são 4000. Somar a corrida daria 5250 — cobrar o tutor
    // por um transporte que a cascata vai cancelar e desfaturar.
    expect(body.totalCents).toBe(10_500)
    expect(body.actions.cancelFeeCents).toBe(4000)
    // O transporte tem bloco próprio na tela; repeti-lo entre os serviços seria dizer a
    // mesma coisa duas vezes.
    expect(body.services).toEqual(['Banho'])
  })
})
