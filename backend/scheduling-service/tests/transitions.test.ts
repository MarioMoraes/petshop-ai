import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/modules/scheduling/booking.js'
import { cancel, checkIn, checkOut, markNoShow } from '../src/modules/scheduling/transitions.js'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenPet,
  givenProfessional,
  givenService,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/** §6 — a máquina de estado, e as rotas que a acionam. */

/**
 * Uma quinta-feira distante, às 9h UTC, e a faixa do dia dela.
 *
 * Era data cravada — `2026-09-03` —, escolhida por ser uma quinta-feira no futuro. Em
 * 03/09/2026 ela virou **hoje**, entrou na janela de 24h do cancelamento e derrubou
 * "cancelar com muita antecedência não é tardio" sem que uma linha de código do serviço
 * tivesse mudado. O que estes casos precisam é de uma quinta-feira **longe**, não de uma
 * quinta-feira específica: data de teste que envelhece é bomba-relógio com pavio de anos.
 */
function quintaDistante(): Date {
  const dia = new Date()
  dia.setUTCHours(9, 0, 0, 0)
  dia.setUTCDate(dia.getUTCDate() + 35)
  // 4 = quinta-feira em `getUTCDay()`.
  dia.setUTCDate(dia.getUTCDate() + ((4 - dia.getUTCDay() + 7) % 7))
  return dia
}

const QUINTA_09H = quintaDistante()

/** Meia-noite da quinta e da sexta seguintes, para as consultas por período. */
const QUINTA_INICIO = new Date(
  Date.UTC(QUINTA_09H.getUTCFullYear(), QUINTA_09H.getUTCMonth(), QUINTA_09H.getUTCDate()),
)
const QUINTA_FIM = new Date(QUINTA_INICIO.getTime() + 24 * 3_600_000)

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function actor() {
  return { tenantId: tenant.tenantId, actorUserId: tenant.userId }
}

async function givenBooking(overrides: { priceCents?: number } = {}) {
  const serviceId = await givenService(tenant, { priceCents: overrides.priceCents ?? 7000 })
  const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
  const { petId } = await givenPet(tenant)
  const booking = await createBooking(actor(), {
    petId,
    professionalId,
    startsAt: QUINTA_09H,
    items: [{ serviceId }],
  })
  return { ...booking, serviceId, professionalId, petId }
}

/**
 * Um horário **dentro da janela de 24h** que não cruza a meia-noite UTC.
 *
 * A jornada é conferida por faixa de um dia da semana: um atendimento que começa às
 * 23:30 e termina 00:30 não cabe em faixa nenhuma, por mais que o profissional atenda
 * 24 horas nos sete dias. `Date.now() + 2h` funciona em quase todo horário do dia e
 * quebra entre 22h e meia-noite UTC — foi assim que estes três testes passaram meses
 * e falharam numa quarta-feira às 21h21.
 *
 * A saída é a madrugada do dia seguinte: sempre no futuro, sempre a menos de 24h de
 * distância quando `agora` está na faixa perigosa, e sempre dentro de um único dia.
 */
function dentroDaJanela(duracaoMin = 60): Date {
  const agora = new Date()
  const candidato = new Date(agora.getTime() + 2 * 3_600_000)
  const fim = new Date(candidato.getTime() + duracaoMin * 60_000)

  if (candidato.getUTCDate() === fim.getUTCDate()) return candidato

  const madrugada = new Date(candidato)
  madrugada.setUTCDate(madrugada.getUTCDate() + (candidato.getUTCHours() >= 12 ? 1 : 0))
  madrugada.setUTCHours(2, 0, 0, 0)
  return madrugada
}

describe('§6 — check-in e check-out', () => {
  it('o fluxo completo leva a COMPLETED e a trilha registra cada passo', async () => {
    const booking = await givenBooking()

    await checkIn(actor(), booking.id)
    await checkOut(actor(), booking.id, { idempotencyKey: randomUUID() })

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.status).toBe('COMPLETED')
    expect(row.checkinAt).not.toBeNull()
    expect(row.checkoutAt).not.toBeNull()

    const log = await ownerPrisma.appointmentStatusLog.findMany({
      where: { appointmentId: booking.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(log.map((l) => l.toStatus)).toEqual(['CONFIRMED', 'CHECKED_IN', 'COMPLETED'])
  })

  it('RN-17: check-in fora do horário é permitido, e o atraso vai para a trilha', async () => {
    const booking = await givenBooking()

    // O agendamento é de mais de um mês adiante e o check-in acontece agora: muito fora
    // do horário. O pet está ali; recusar não o faria ir embora.
    await checkIn(actor(), booking.id)

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { entityId: booking.id, action: 'appointment.checked_in' },
    })
    expect((audit.after as Record<string, unknown>).delayMin).toBeDefined()
  })

  it('RN-18: item acrescentado no check-out soma ao total', async () => {
    const booking = await givenBooking({ priceCents: 7000 })
    const hidratacao = await givenService(tenant, { name: 'Hidratação', priceCents: 3000 })

    await checkIn(actor(), booking.id)
    const result = await checkOut(actor(), booking.id, {
      idempotencyKey: randomUUID(),
      extraItems: [{ serviceId: hidratacao }],
    })

    expect(result.totalCents).toBe(10_000)

    const items = await ownerPrisma.appointmentItem.findMany({
      where: { appointmentId: booking.id },
    })
    expect(items).toHaveLength(2)
    expect(items.some((item) => item.addedAtCheckout)).toBe(true)
  })

  it('o check-out é idempotente: a mesma chave não lança duas vezes', async () => {
    const booking = await givenBooking()
    const key = randomUUID()
    const hidratacao = await givenService(tenant, { name: 'Hidratação', priceCents: 3000 })

    await checkIn(actor(), booking.id)
    const primeiro = await checkOut(actor(), booking.id, {
      idempotencyKey: key,
      extraItems: [{ serviceId: hidratacao }],
    })
    const segundo = await checkOut(actor(), booking.id, {
      idempotencyKey: key,
      extraItems: [{ serviceId: hidratacao }],
    })

    expect(primeiro.repeated).toBe(false)
    expect(segundo.repeated).toBe(true)
    expect(segundo.totalCents).toBe(primeiro.totalCents)

    // O duplo clique não criou um segundo item nem um segundo lançamento.
    const items = await ownerPrisma.appointmentItem.findMany({
      where: { appointmentId: booking.id },
    })
    expect(items).toHaveLength(2)
  })

  it('COMPLETED é terminal: não volta para nada', async () => {
    const booking = await givenBooking()
    await checkIn(actor(), booking.id)
    await checkOut(actor(), booking.id, { idempotencyKey: randomUUID() })

    await expect(cancel(actor(), booking.id)).rejects.toMatchObject({ code: 'ERR_AGENDA_006' })
    await expect(checkIn(actor(), booking.id)).rejects.toMatchObject({ code: 'ERR_AGENDA_006' })
  })

  it('transição inválida é 409 e diz em que estado o agendamento está', async () => {
    const booking = await givenBooking()
    await cancel(actor(), booking.id)

    const erro = await checkIn(actor(), booking.id).catch((e: unknown) => e)
    expect(erro).toMatchObject({ code: 'ERR_AGENDA_006', status: 409 })
    expect((erro as Error).message).toContain('cancelado')
  })
})

describe('RN-06 — cancelamento e a janela de 24h', () => {
  it('cancelar com muita antecedência não é tardio e não gera taxa', async () => {
    const booking = await givenBooking()

    const result = await cancel(actor(), booking.id, { reason: 'Tutor viajou' })

    expect(result.late).toBe(false)
    expect(result.feeCents).toBe(0)

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.cancelledLate).toBe(false)
    // O motivo é campo livre e vai cifrado (§9).
    expect(row.cancelReasonEncrypted).not.toBeNull()
    expect(row.cancelReasonEncrypted).not.toContain('viajou')
  })

  it('dentro da janela é tardio e calcula a taxa pelo percentual do tenant', async () => {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { cancellationWindowHours: 24, noShowFeePercent: 50 },
    })

    // Agendamento para daqui a 2 horas: dentro da janela de 24h.
    const serviceId = await givenService(tenant, { priceCents: 10_000 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startsAtMin: 0,
        endsAtMin: 1440,
      })),
    })
    const { petId } = await givenPet(tenant)
    const daquiDuasHoras = dentroDaJanela()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: daquiDuasHoras,
      items: [{ serviceId }],
    })

    const result = await cancel(actor(), booking.id)

    expect(result.late).toBe(true)
    expect(result.feeCents).toBe(5_000)
  })

  it('a recepção pode isentar a taxa do cancelamento tardio', async () => {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { cancellationWindowHours: 24, noShowFeePercent: 50 },
    })

    const serviceId = await givenService(tenant, { priceCents: 10_000 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startsAtMin: 0,
        endsAtMin: 1440,
      })),
    })
    const { petId } = await givenPet(tenant)
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: dentroDaJanela(),
      items: [{ serviceId }],
    })

    const result = await cancel(actor(), booking.id, { waiveFee: true })

    // Continua marcado como tardio — o fato aconteceu —, mas sem cobrança.
    expect(result.late).toBe(true)
    expect(result.feeCents).toBe(0)
  })

  it('RN-12: cancelamento do sistema nunca é tardio', async () => {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { cancellationWindowHours: 24, noShowFeePercent: 50 },
    })

    const serviceId = await givenService(tenant, { priceCents: 10_000 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startsAtMin: 0,
        endsAtMin: 1440,
      })),
    })
    const { petId } = await givenPet(tenant)
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: dentroDaJanela(),
      items: [{ serviceId }],
    })

    // A falta é do petshop, não do tutor.
    const result = await cancel(actor(), booking.id, { systemInitiated: true })

    expect(result.late).toBe(false)
    expect(result.feeCents).toBe(0)
  })
})

describe('no-show', () => {
  it('calcula a taxa pelo percentual e é terminal', async () => {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { noShowFeePercent: 30 },
    })
    const booking = await givenBooking({ priceCents: 10_000 })

    const result = await markNoShow(actor(), booking.id)
    expect(result.feeCents).toBe(3_000)

    await expect(checkIn(actor(), booking.id)).rejects.toMatchObject({ code: 'ERR_AGENDA_006' })
  })
})

describe('rotas do agendamento', () => {
  it('POST cria e devolve 201 com o agendamento montado', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant, { name: 'Thor' })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/appointments',
      payload: {
        petId,
        professionalId,
        startsAt: QUINTA_09H.toISOString(),
        items: [{ serviceId }],
        notes: 'Tocar o interfone 2',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('CONFIRMED')
    expect(body.petName).toBe('Thor')
    expect(body.professionalName).toBe('Ana')
    expect(body.items).toHaveLength(1)
    // A observação volta decifrada no detalhe.
    expect(body.notes).toBe('Tocar o interfone 2')
  })

  it('GET /v1/availability devolve os horários já com preço e duração do pet', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60, priceCents: 9000 })
    await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant, { sizeKey: 'LARGE', coatKey: 'SHORT' })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/availability?serviceId=${serviceId}&petId=${petId}&from=${QUINTA_INICIO.toISOString()}&to=${QUINTA_FIM.toISOString()}`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.durationMin).toBe(60)
    expect(body.priceCents).toBe(9000)
    expect(body.slots.length).toBeGreaterThan(0)
    expect(body.slots[0].professionalName).toBe('Ana')
  })

  it('a listagem filtra por período e não traz a observação', async () => {
    const booking = await givenBooking()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/appointments/${booking.id}/checkin`,
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/appointments?from=${QUINTA_INICIO.toISOString()}&to=${QUINTA_FIM.toISOString()}`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toHaveLength(1)
    expect(body[0].status).toBe('CHECKED_IN')
    // Campo livre com risco de PII não vai na listagem do dia.
    expect(body[0].notes).toBeNull()
  })

  it('não enxerga agendamento de outro tenant', async () => {
    await givenBooking()
    const outro = await givenTenant('Outro Petshop')

    const response = await callApi({
      ...asAdmin(outro),
      method: 'GET',
      url: '/v1/appointments',
    })
    expect(response.json()).toHaveLength(0)
  })
})
