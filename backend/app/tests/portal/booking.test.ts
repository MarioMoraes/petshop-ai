import { AppError, formatBRL } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  callApi,
  closeHarness,
  fakeScheduling,
  givenAppointment,
  givenPet,
  givenProfessional,
  givenService,
  givenTenant,
  givenTutor,
  resetDatabase,
  setSettings,
  type SchedulingDouble,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-PORTAL-05 e 06 — marcar horário e cuidar do que já está marcado.
 *
 * A regra de agenda tem suíte própria no scheduling-service, e repeti-la aqui só
 * produziria dois lugares para consertar quando ela mudar. O que **esta** suíte guarda
 * é o que o BFF acrescenta e ninguém mais faz:
 *
 * - a posse do pet e do agendamento, checada antes de qualquer chamada ao domínio;
 * - o recorte do cardápio — o que não tem preço ou executor não é oferecido;
 * - o filtro da antecedência mínima, que impede a tela de mostrar o que o POST recusa;
 * - o reconhecimento do duplo toque;
 * - a tradução do erro do balcão para linguagem de cliente;
 * - a taxa do cancelamento tardio dita **antes** de cancelar.
 */

let fixture: TenantFixture
let scheduling: SchedulingDouble

/** Amanhã às 14:00 UTC — longe da antecedência mínima e do fim do dia em qualquer fuso. */
function amanha(hora = 14): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + 1)
  date.setUTCHours(hora, 0, 0, 0)
  return date
}

function dia(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  scheduling = fakeScheduling(fixture)
})

afterAll(async () => {
  await closeHarness()
})

describe('GET /portal/v1/booking/services', () => {
  it('lista os serviços agendáveis com o preço deste pet (AC-02)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    await givenService(fixture, { name: 'Banho', priceCents: 9500, professionalId })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/services?petId=${petId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { petName: string; services: Record<string, unknown>[] }
    expect(body.services).toHaveLength(1)
    expect(body.services[0]).toMatchObject({ name: 'Banho', priceCents: 9500 })
  })

  it('não oferece serviço sem preço para o porte, nem sem quem execute', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)

    await givenService(fixture, { name: 'Com tudo', professionalId })
    await givenService(fixture, { name: 'Sem preço', priced: false, professionalId })
    await givenService(fixture, { name: 'Sem executor' })
    await givenService(fixture, { name: 'Desativado', active: false, professionalId })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/services?petId=${petId}`,
      ...asTutor(fixture, tutorId),
    })

    const { services } = response.json() as { services: { name: string }[] }
    expect(services.map((service) => service.name)).toEqual(['Com tudo'])
  })

  it('não oferece Taxi Dog como se fosse um banho', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    await givenService(fixture, { name: 'Leva e traz', category: 'TAXI', professionalId })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/services?petId=${petId}`,
      ...asTutor(fixture, tutorId),
    })

    expect((response.json() as { services: unknown[] }).services).toHaveLength(0)
  })

  it('responde 404 para o pet de outro tutor', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs)

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/services?petId=${petId}`,
      ...asTutor(fixture, mine),
    })

    expect(response.statusCode).toBe(404)
  })

  it('responde 403 com o agendamento online desligado (AC-07)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    await setSettings(fixture, { onlineBookingEnabled: false })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/services?petId=${petId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'ERR_PORTAL_008' })
  })
})

describe('GET /portal/v1/booking/availability', () => {
  it('devolve os horários do domínio, sem recalcular nada (AC-01)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    const serviceId = await givenService(fixture, { professionalId })

    const horario = amanha(14)
    scheduling.slots = [{ startsAt: horario, professionalId, professionalName: 'Ana Banhista' }]

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/availability?petId=${petId}&serviceIds=${serviceId}&date=${dia(horario)}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { slots: { startsAt: string }[]; minNoticeHours: number }
    expect(body.slots).toHaveLength(1)
    expect(body.slots[0]?.startsAt).toBe(horario.toISOString())
    expect(body.minNoticeHours).toBe(2)
    expect(scheduling.calls.availability).toHaveLength(1)
  })

  it('esconde o horário dentro da antecedência mínima, em vez de deixar o POST recusar (RN-07)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    const serviceId = await givenService(fixture, { professionalId })
    await setSettings(fixture, { minBookingNoticeHours: 6 })

    const cedo = new Date(Date.now() + 60 * 60 * 1000)
    const tarde = new Date(Date.now() + 8 * 60 * 60 * 1000)
    scheduling.slots = [
      { startsAt: cedo, professionalId, professionalName: 'Ana' },
      { startsAt: tarde, professionalId, professionalName: 'Ana' },
    ]

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/availability?petId=${petId}&serviceIds=${serviceId}&date=${dia(tarde)}`,
      ...asTutor(fixture, tutorId),
    })

    const body = response.json() as { slots: { startsAt: string }[]; minNoticeHours: number }
    expect(body.slots.map((slot) => slot.startsAt)).toEqual([tarde.toISOString()])
    expect(body.minNoticeHours).toBe(6)
  })

  it('não consulta a agenda do pet de outro tutor', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs)
    const serviceId = await givenService(fixture)

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/booking/availability?petId=${petId}&serviceIds=${serviceId}&date=${dia(amanha())}`,
      ...asTutor(fixture, mine),
    })

    expect(response.statusCode).toBe(404)
    expect(scheduling.calls.availability).toHaveLength(0)
  })
})

describe('POST /portal/v1/booking', () => {
  async function cenario() {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    const serviceId = await givenService(fixture, { professionalId })
    return { tutorId, petId, professionalId, serviceId }
  }

  it('cria o agendamento com origem PORTAL e devolve 201 (AC-03)', async () => {
    const { tutorId, petId, professionalId, serviceId } = await cenario()
    const horario = amanha()

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        professionalId,
        serviceIds: [serviceId],
        startsAt: horario.toISOString(),
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ awaitingApproval: false, duplicate: false })
    expect(scheduling.calls.created[0]).toMatchObject({ source: 'PORTAL' })
  })

  it('entra aguardando confirmação quando o petshop tria (AC-06)', async () => {
    const { tutorId, petId, professionalId, serviceId } = await cenario()
    await setSettings(fixture, { onlineBookingRequiresApproval: true })

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        professionalId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ status: 'PENDING', awaitingApproval: true })
  })

  it('o duplo toque devolve o agendamento que já existe, e não um segundo', async () => {
    const { tutorId, petId, professionalId, serviceId } = await cenario()
    const payload = {
      petId,
      professionalId,
      serviceIds: [serviceId],
      startsAt: amanha().toISOString(),
    }

    const primeira = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload,
      ...asTutor(fixture, tutorId),
    })
    const segunda = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload,
      ...asTutor(fixture, tutorId),
    })

    expect(primeira.statusCode).toBe(201)
    expect(segunda.statusCode).toBe(200)
    expect((segunda.json() as { id: string }).id).toBe((primeira.json() as { id: string }).id)
    expect(scheduling.calls.created).toHaveLength(1)
  })

  it('não agenda o pet de outro tutor', async () => {
    const { professionalId, serviceId } = await cenario()
    const outro = await givenTutor(fixture, { phone: '+5511911112222' })
    const petDoOutro = await givenPet(fixture, outro, { name: 'Rex' })
    const intruso = await givenTutor(fixture, { phone: '+5511933334444' })

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId: petDoOutro,
        professionalId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
      },
      ...asTutor(fixture, intruso),
    })

    expect(response.statusCode).toBe(404)
    expect(scheduling.calls.created).toHaveLength(0)
  })

  it('traduz a antecedência mínima para uma frase com a saída (AC-04)', async () => {
    const { tutorId, petId, professionalId, serviceId } = await cenario()
    scheduling.failCreateWith = new AppError(
      'ERR_AGENDA_007',
      'Agendamentos pelo portal exigem 2h de antecedência',
      undefined,
      { nextAvailable: amanha(11).toISOString(), minNoticeHours: 2 },
    )

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        professionalId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(422)
    const body = response.json() as { code: string; detail: string }
    expect(body.code).toBe('ERR_AGENDA_007')
    expect(body.detail).toContain('2 horas de antecedência')
    expect(body.detail).toMatch(/a partir das \d{2}:\d{2}/)
  })

  it('barra o inadimplente sem oferecer a liberação que é da equipe (AC-05)', async () => {
    const { tutorId, petId, professionalId, serviceId } = await cenario()
    scheduling.failCreateWith = new AppError(
      'ERR_AGENDA_008',
      'O tutor tem R$ 280,00 em aberto, acima do limite de R$ 100,00',
      undefined,
      { balanceCents: -28000, creditLimitCents: 10000, requiresOverride: true },
    )

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        professionalId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(409)
    const body = response.json() as Record<string, unknown>
    expect(body.code).toBe('ERR_AGENDA_008')
    // `formatBRL` separa o símbolo com espaço não separável; comparar com um espaço
    // comum digitado aqui falharia por um caractere invisível.
    expect(body.detail).toContain(formatBRL(28000))
    expect(body.requiresOverride).toBeUndefined()
  })

  it('a corrida pelo último horário chega com as sugestões, não como erro genérico (AC-08)', async () => {
    const { tutorId, petId, professionalId, serviceId } = await cenario()
    const sugestao = amanha(15).toISOString()
    scheduling.failCreateWith = new AppError(
      'ERR_AGENDA_004',
      'Ana Banhista já tem 1 pet neste horário',
      undefined,
      { suggestions: [{ startsAt: sugestao, endsAt: sugestao }] },
    )

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        professionalId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(409)
    const body = response.json() as { detail: string; suggestions: unknown[] }
    expect(body.detail).toContain('acabou de ser preenchido')
    expect(body.suggestions).toHaveLength(1)
  })

  it('recusa o pedido com campo que o tutor não pode mandar', async () => {
    const { tutorId, petId, professionalId, serviceId } = await cenario()

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/booking',
      payload: {
        petId,
        professionalId,
        serviceIds: [serviceId],
        startsAt: amanha().toISOString(),
        override: { reason: 'sou bom cliente há muitos anos' },
      },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(422)
  })
})

describe('GET /portal/v1/appointments', () => {
  it('separa os próximos dos passados (AC-01)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)

    await givenAppointment(fixture, tutorId, petId, professionalId, {
      startsAt: amanha(),
      serviceLabel: 'Banho',
    })
    await givenAppointment(fixture, tutorId, petId, professionalId, {
      startsAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      status: 'COMPLETED',
      serviceLabel: 'Tosa',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/appointments',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      upcoming: { services: string[] }[]
      past: { services: string[] }[]
    }
    expect(body.upcoming).toHaveLength(1)
    expect(body.upcoming[0]?.services).toEqual(['Banho'])
    expect(body.past).toHaveLength(1)
    expect(body.past[0]?.services).toEqual(['Tosa'])
  })

  it('não mostra o agendamento de outro tutor', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs)
    const professionalId = await givenProfessional(fixture)
    await givenAppointment(fixture, theirs, petId, professionalId, { startsAt: amanha() })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/appointments',
      ...asTutor(fixture, mine),
    })

    const body = response.json() as { upcoming: unknown[]; past: unknown[] }
    expect(body.upcoming).toHaveLength(0)
    expect(body.past).toHaveLength(0)
  })

  it('o detalhe do agendamento de outro tutor é 404, não 403', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs)
    const professionalId = await givenProfessional(fixture)
    const appointmentId = await givenAppointment(fixture, theirs, petId, professionalId, {
      startsAt: amanha(),
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/appointments/${appointmentId}`,
      ...asTutor(fixture, mine),
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('POST /portal/v1/appointments/:id/cancel', () => {
  async function agendamento(startsAt: Date, status?: 'CONFIRMED' | 'CHECKED_IN' | 'IN_PROGRESS') {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    const id = await givenAppointment(fixture, tutorId, petId, professionalId, {
      startsAt,
      ...(status ? { status } : {}),
    })
    return { tutorId, appointmentId: id }
  }

  it('cancela sem taxa dentro da janela (AC-02)', async () => {
    const { tutorId, appointmentId } = await agendamento(
      new Date(Date.now() + 72 * 60 * 60 * 1000),
    )
    await setSettings(fixture, { cancellationWindowHours: 24, noShowFeePercent: 30 })

    const response = await callApi({
      method: 'POST',
      url: `/portal/v1/appointments/${appointmentId}/cancel`,
      payload: {},
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'CANCELLED' })
    expect(scheduling.calls.cancelled).toEqual([appointmentId])
  })

  it('diz o valor da taxa antes de cancelar, e só cancela na confirmação (AC-03)', async () => {
    const { tutorId, appointmentId } = await agendamento(new Date(Date.now() + 2 * 60 * 60 * 1000))
    await setSettings(fixture, { cancellationWindowHours: 24, noShowFeePercent: 50 })

    const aviso = await callApi({
      method: 'POST',
      url: `/portal/v1/appointments/${appointmentId}/cancel`,
      payload: {},
      ...asTutor(fixture, tutorId),
    })

    expect(aviso.statusCode).toBe(409)
    const body = aviso.json() as { code: string; feeCents: number; detail: string }
    expect(body.code).toBe('ERR_PORTAL_011')
    expect(body.feeCents).toBe(4000)
    expect(body.detail).toContain(formatBRL(4000))
    expect(scheduling.calls.cancelled).toHaveLength(0)

    const confirmado = await callApi({
      method: 'POST',
      url: `/portal/v1/appointments/${appointmentId}/cancel`,
      payload: { acknowledgeFee: true },
      ...asTutor(fixture, tutorId),
    })

    expect(confirmado.statusCode).toBe(200)
    expect(scheduling.calls.cancelled).toEqual([appointmentId])
  })

  it('sem percentual de taxa, o cancelamento tardio passa de primeira', async () => {
    const { tutorId, appointmentId } = await agendamento(new Date(Date.now() + 2 * 60 * 60 * 1000))
    await setSettings(fixture, { cancellationWindowHours: 24, noShowFeePercent: 0 })

    const response = await callApi({
      method: 'POST',
      url: `/portal/v1/appointments/${appointmentId}/cancel`,
      payload: {},
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
  })

  it('o pet que já está no petshop não se cancela pelo site (AC-05)', async () => {
    const { tutorId, appointmentId } = await agendamento(
      new Date(Date.now() + 60 * 60 * 1000),
      'CHECKED_IN',
    )

    const response = await callApi({
      method: 'POST',
      url: `/portal/v1/appointments/${appointmentId}/cancel`,
      payload: { acknowledgeFee: true },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(409)
    const body = response.json() as { code: string; detail: string }
    expect(body.code).toBe('ERR_PORTAL_009')
    expect(body.detail).toContain('já está no petshop')
    expect(scheduling.calls.cancelled).toHaveLength(0)
  })
})

describe('POST /portal/v1/appointments/:id/reschedule', () => {
  it('remarca e devolve o agendamento novo (AC-04)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    const appointmentId = await givenAppointment(fixture, tutorId, petId, professionalId, {
      startsAt: amanha(9),
    })

    const novoHorario = amanha(16)
    const response = await callApi({
      method: 'POST',
      url: `/portal/v1/appointments/${appointmentId}/reschedule`,
      payload: { startsAt: novoHorario.toISOString(), professionalId },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { id: string; startsAt: string }
    expect(body.id).not.toBe(appointmentId)
    expect(body.startsAt).toBe(novoHorario.toISOString())
  })

  it('não remarca com o agendamento online desligado', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)
    const appointmentId = await givenAppointment(fixture, tutorId, petId, professionalId, {
      startsAt: amanha(9),
    })
    await setSettings(fixture, { onlineBookingEnabled: false })

    const response = await callApi({
      method: 'POST',
      url: `/portal/v1/appointments/${appointmentId}/reschedule`,
      payload: { startsAt: amanha(16).toISOString(), professionalId },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(403)
    expect(scheduling.calls.rescheduled).toHaveLength(0)
  })
})
