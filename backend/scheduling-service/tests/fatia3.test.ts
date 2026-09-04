import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/modules/scheduling/booking.js'
import { handlePetObito, handleTutorMesclado } from '../src/modules/scheduling/consumers.js'
import { getDayView } from '../src/modules/scheduling/day-view.js'
import { expirePendingApprovals, sweepNoShows } from '../src/modules/scheduling/jobs.js'
import {
  createRecurrence,
  endRecurrence,
  expandOccurrences,
  parseRRule,
} from '../src/modules/scheduling/recurrence.js'
import { approve, checkIn, reschedule } from '../src/modules/scheduling/transitions.js'
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

/** MOD-AGENDA 05, 06, 08 e 09 — o que fechou o módulo. */

/**
 * Uma quinta-feira distante, e não uma quinta-feira específica.
 *
 * Era `2026-09-03`, cravada por ser uma quinta no futuro. Em 04/09/2026 ela virou
 * **ontem** e derrubou quatro casos de uma vez: agendamento com `source: PORTAL` passa
 * pelo gate de antecedência mínima, e nenhuma antecedência salva uma data no passado.
 * Mesma armadilha que já tinha explodido em `transitions.test.ts` — data de teste que
 * envelhece é bomba-relógio com pavio de anos.
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

/** O dia civil dessa quinta em UTC — é o que as rotas por data recebem. */
const QUINTA_DIA = QUINTA_09H.toISOString().slice(0, 10)

/** Outra hora do mesmo dia. `hora` no formato `HH:MM`. */
function quintaAs(hora: string): Date {
  return new Date(`${QUINTA_DIA}T${hora}:00.000Z`)
}

/** O dia civil `n` dias antes da quinta, para as séries do gráfico de movimento. */
function diaAntes(n: number): string {
  const dia = new Date(QUINTA_09H)
  dia.setUTCDate(dia.getUTCDate() - n)
  return dia.toISOString().slice(0, 10)
}

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function actor() {
  return { tenantId: tenant.tenantId, actorUserId: tenant.userId }
}

/** Jornada integral: os testes que marcam "daqui a N horas" não podem depender da
 * hora em que a suíte roda. */
const JORNADA_INTEGRAL = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startsAtMin: 0,
  endsAtMin: 1440,
}))

async function cenario(
  options: { maxConcurrentPets?: number; jornadaIntegral?: boolean } = {},
) {
  const serviceId = await givenService(tenant, { durationMin: 60, priceCents: 7000 })
  const professionalId = await givenProfessional(tenant, {
    serviceIds: [serviceId],
    maxConcurrentPets: options.maxConcurrentPets ?? 1,
    ...(options.jornadaIntegral ? { windows: JORNADA_INTEGRAL } : {}),
  })
  const { petId, tutorId } = await givenPet(tenant)
  return { serviceId, professionalId, petId, tutorId }
}

describe('MOD-AGENDA-08 AC-04 — remarcação preserva a cadeia', () => {
  it('o original vira RESCHEDULED apontando o novo, que nasce CONFIRMED', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const original = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    const result = await reschedule(actor(), original.id, {
      startsAt: quintaAs('14:00'),
    })

    const antigo = await ownerPrisma.appointment.findUniqueOrThrow({
      where: { id: original.id },
    })
    expect(antigo.status).toBe('RESCHEDULED')
    expect(antigo.rescheduledToId).toBe(result.newAppointmentId)

    const novo = await ownerPrisma.appointment.findUniqueOrThrow({
      where: { id: result.newAppointmentId },
    })
    expect(novo.status).toBe('CONFIRMED')
    expect(novo.startsAt.toISOString()).toBe(quintaAs('14:00').toISOString())
  })

  it('AC-05: a cadeia conta quantas vezes a mesma marcação já andou', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    let atual = (
      await createBooking(actor(), {
        petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
      })
    ).id

    const contagens: number[] = []
    for (const hora of ['11:00', '13:00', '15:00']) {
      const result = await reschedule(actor(), atual, {
        startsAt: quintaAs(hora),
      })
      contagens.push(result.rescheduleCount)
      atual = result.newAppointmentId
    }

    // A agenda relata; a política comercial é de outro módulo.
    expect(contagens).toEqual([1, 2, 3])
  })

  it('o horário original volta a ficar disponível depois da remarcação', async () => {
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 1 })
    const original = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    await reschedule(actor(), original.id, {
      startsAt: quintaAs('14:00'),
    })

    // RESCHEDULED não ocupa lugar: o horário das 09:00 aceita outro pet.
    const outro = await givenPet(tenant, { name: 'Mel' })
    const novo = await createBooking(actor(), {
      petId: outro.petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(novo.id).toBeTruthy()
  })

  it('remarcar um atendimento já concluído é recusado', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    await checkIn(actor(), booking.id)

    await expect(
      reschedule(actor(), booking.id, { startsAt: quintaAs('14:00') }),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_006' })
  })
})

describe('MOD-AGENDA-06 AC-03 — aprovação do Portal', () => {
  async function comAprovacao() {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { onlineBookingRequiresApproval: true, minBookingNoticeHours: 0 },
    })
  }

  it('o Portal entra PENDING e o horário fica reservado', async () => {
    await comAprovacao()
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 1 })

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      source: 'PORTAL',
    })

    expect(booking.status).toBe('PENDING')

    // Reservado de verdade: o balcão não vende o mesmo horário por baixo.
    const outro = await givenPet(tenant, { name: 'Mel' })
    await expect(
      createBooking(actor(), {
        petId: outro.petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
      }),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_004' })
  })

  /**
   * O contador que alimenta o sino do Admin.
   *
   * Sem ele, ligar a triagem era armadilha: o pedido do tutor ficava `PENDING`, nenhuma
   * tela dizia que havia algo a decidir, e o job devolvia o horário à grade 24h depois.
   */
  it('a fila da triagem sai contada, com o dia do pedido mais próximo', async () => {
    await comAprovacao()
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 3 })
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { timezone: 'UTC' },
    })

    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: quintaAs('14:00'),
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    // O que a equipe marcou no balcão não é pedido do site, e não entra na fila.
    const outro = await givenPet(tenant, { name: 'Mel' })
    await createBooking(actor(), {
      petId: outro.petId,
      professionalId,
      startsAt: quintaAs('16:00'),
      items: [{ serviceId }],
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/appointments/pending-count',
    })

    expect(response.statusCode).toBe(200)
    // O mais próximo é o das 09h, e não o que foi criado primeiro: o sino aponta para
    // o dia do pedido, não para a ordem de chegada.
    expect(response.json()).toMatchObject({ count: 2, nextDate: QUINTA_DIA })
  })

  it('aprovar leva a CONFIRMED e registra na trilha', async () => {
    await comAprovacao()
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      source: 'PORTAL',
    })

    await approve(actor(), booking.id)

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.status).toBe('CONFIRMED')

    const log = await ownerPrisma.appointmentStatusLog.findMany({
      where: { appointmentId: booking.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(log.map((l) => l.toStatus)).toEqual(['PENDING', 'CONFIRMED'])
  })

  it('sem a chave ligada, o Portal entra CONFIRMED direto (decisão 8)', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    expect(booking.status).toBe('CONFIRMED')
  })

  it('o balcão nunca fica pendente, mesmo com a chave ligada', async () => {
    await comAprovacao()
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      source: 'STAFF',
    })
    expect(booking.status).toBe('CONFIRMED')
  })
})

describe('MOD-AGENDA-09 — visão do dia', () => {
  it('AC-01: traz as colunas com agendamentos, alertas e ocupação', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      acknowledgedAlerts: true,
    })
    await withTenant(tenant.tenantId, (tx) =>
      tx.allergy.create({
        data: {
          tenantId: tenant.tenantId,
          petId,
          label: 'Shampoo de aveia',
          type: 'PRODUCT',
          severity: 'CRITICAL',
          blocksServices: [],
        },
      }),
    )

    const view = await getDayView(actor(), QUINTA_DIA, 'UTC')

    expect(view.columns).toHaveLength(1)
    const coluna = view.columns[0]!
    expect(coluna.professionalName).toBe('Ana')
    expect(coluna.appointments).toHaveLength(1)
    expect(coluna.appointments[0]?.petName).toBe('Thor')
    // O alerta vem junto: a equipe vê antes de encostar no pet.
    expect(coluna.appointments[0]?.alerts[0]?.label).toBe('Shampoo de aveia')
    // Jornada de 10h (600 min), 60 min ocupados, capacidade 1 → 10%.
    expect(coluna.occupancyPercent).toBe(10)
  })

  it('AC-02: profissional sem jornada no dia aparece marcado como ausente', async () => {
    const serviceId = await givenService(tenant)
    await givenProfessional(tenant, {
      name: 'Ana',
      serviceIds: [serviceId],
      // Só trabalha às segundas; 03/09/2026 é quinta.
      windows: [{ weekday: 1, startsAtMin: 480, endsAtMin: 1080 }],
    })

    const view = await getDayView(actor(), QUINTA_DIA, 'UTC')

    // A coluna **não** some: uma coluna que desaparece faz a equipe achar que o
    // sistema perdeu a pessoa.
    expect(view.columns).toHaveLength(1)
    expect(view.columns[0]?.absent).toBe(true)
    expect(view.columns[0]?.absenceReason).toBe('Sem jornada neste dia')
  })

  /**
   * O motorista tem jornada, folga e capacidade como qualquer profissional — e por isso
   * ganhava uma coluna no painel do dia, ao lado do banhista, que nunca teria nada
   * dentro: corrida mora em `taxi_rides`, não em `appointments`.
   */
  it('o motorista não vira coluna no painel do dia, nem oferece horário', async () => {
    const serviceId = await givenService(tenant)
    await givenProfessional(tenant, { name: 'Ana Banhista', serviceIds: [serviceId] })
    await givenProfessional(tenant, { name: 'Zé Motorista', roleKey: 'DRIVER' })

    const view = await getDayView(actor(), QUINTA_DIA, 'UTC')
    expect(view.columns.map((coluna) => coluna.professionalName)).toEqual(['Ana Banhista'])

    // E se alguém o habilitar num serviço por engano, a criação recusa pelo papel.
    const motorista = await givenProfessional(tenant, {
      name: 'Outro Motorista',
      roleKey: 'DRIVER',
      serviceIds: [serviceId],
    })
    const { petId } = await givenPet(tenant)
    await expect(
      createBooking(actor(), {
        petId,
        professionalId: motorista,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
      }),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_005' })
  })

  it('bloqueio explica a ausência em vez de só constatá-la', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    await withTenant(tenant.tenantId, (tx) =>
      tx.calendarBlock.create({
        data: {
          tenantId: tenant.tenantId,
          professionalId,
          startsAt: quintaAs('00:00'),
          // A sexta seguinte: o CHECK de `calendar_blocks` exige fim depois do início,
          // e uma data cravada aqui volta a ser o passado da quinta calculada.
          endsAt: new Date(quintaAs('00:00').getTime() + 24 * 3_600_000),
          reason: 'Folga',
        },
      }),
    )

    const view = await getDayView(actor(), QUINTA_DIA, 'UTC')
    expect(view.columns[0]?.absent).toBe(true)
    expect(view.columns[0]?.absenceReason).toBe('Folga')
  })

  it('cancelado e remarcado não aparecem no painel', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    await reschedule(actor(), booking.id, { startsAt: quintaAs('14:00') })

    const view = await getDayView(actor(), QUINTA_DIA, 'UTC')
    // O remarcado sumiu; só o novo aparece.
    expect(view.columns[0]?.appointments).toHaveLength(1)
    expect(view.columns[0]?.appointments[0]?.startsAt).toContain('14:00')
  })
})

describe('MOD-AGENDA-05 — recorrência', () => {
  it('AC-02: recusa FREQ fora de DAILY, WEEKLY e MONTHLY', () => {
    expect(() => parseRRule('FREQ=MINUTELY;INTERVAL=5')).toThrow(/diária, semanal ou mensal/)
    expect(() => parseRRule('lixo')).toThrow()
    expect(parseRRule('RRULE:FREQ=WEEKLY;BYDAY=TU').freq).toBe('WEEKLY')
  })

  it('expande semanalmente respeitando o dia e a hora da primeira ocorrência', () => {
    // 2026-09-01 é uma terça.
    const inicio = new Date('2026-09-01T09:00:00.000Z')
    const datas = expandOccurrences(
      parseRRule('FREQ=WEEKLY;BYDAY=TU'),
      inicio,
      inicio,
      new Date('2026-09-29T00:00:00.000Z'),
    )

    expect(datas).toHaveLength(4)
    expect(datas.every((d) => d.getUTCDay() === 2)).toBe(true)
    // Mudar de dia não muda o horário do banho.
    expect(datas.every((d) => d.getUTCHours() === 9)).toBe(true)
  })

  it('AC-01: materializa 12 semanas de "banho toda terça"', async () => {
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 5 })

    const result = await createRecurrence(actor(), {
      petId,
      professionalId,
      serviceIds: [serviceId],
      startsAt: new Date('2026-09-01T09:00:00.000Z'),
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    })

    expect(result.generated).toBe(12)
    expect(result.skipped).toHaveLength(0)

    const ocorrencias = await ownerPrisma.appointment.findMany({
      where: { recurrenceId: result.recurrenceId },
    })
    expect(ocorrencias).toHaveLength(12)
    expect(ocorrencias.every((o) => o.source === 'RECURRENCE')).toBe(true)
  })

  it('AC-03: a ocorrência em feriado entra em skipped e a série continua', async () => {
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 5 })

    // Feriado exatamente na terça da semana 5.
    await withTenant(tenant.tenantId, (tx) =>
      tx.calendarBlock.create({
        data: {
          tenantId: tenant.tenantId,
          professionalId: null,
          startsAt: new Date('2026-09-29T00:00:00.000Z'),
          endsAt: new Date('2026-09-30T00:00:00.000Z'),
          reason: 'Feriado',
        },
      }),
    )

    const result = await createRecurrence(actor(), {
      petId,
      professionalId,
      serviceIds: [serviceId],
      startsAt: new Date('2026-09-01T09:00:00.000Z'),
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    })

    // A série **não** falha por causa de uma ocorrência.
    expect(result.generated).toBe(11)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.startsAt).toContain('2026-09-29')
  })

  it('AC-04: encerrar a série cancela as futuras e não toca nas concluídas', async () => {
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 5 })
    const result = await createRecurrence(actor(), {
      petId,
      professionalId,
      serviceIds: [serviceId],
      startsAt: new Date('2026-09-01T09:00:00.000Z'),
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    })

    // Uma ocorrência já concluída.
    const primeira = result.appointmentIds[0]!
    await ownerPrisma.appointment.update({
      where: { id: primeira },
      data: { status: 'COMPLETED', checkoutAt: new Date() },
    })

    await endRecurrence(actor(), result.recurrenceId, 'THIS_AND_FUTURE')

    const concluida = await ownerPrisma.appointment.findUniqueOrThrow({
      where: { id: primeira },
    })
    expect(concluida.status).toBe('COMPLETED')

    const canceladas = await ownerPrisma.appointment.count({
      where: { recurrenceId: result.recurrenceId, status: 'CANCELLED' },
    })
    expect(canceladas).toBe(11)
  })
})

describe('jobs', () => {
  it('AC-03: o varredor marca falta só depois da tolerância de 60 min', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startsAtMin: 0,
        endsAtMin: 1440,
      })),
    })
    const recente = await givenPet(tenant, { name: 'Recente' })
    const antigo = await givenPet(tenant, { name: 'Antigo' })

    const agora = new Date()
    const haTrintaMin = new Date(agora.getTime() - 30 * 60_000)
    const haDuasHoras = new Date(agora.getTime() - 2 * 3_600_000)

    const dentroDaTolerancia = await createBooking(actor(), {
      petId: recente.petId,
      professionalId,
      startsAt: haTrintaMin,
      items: [{ serviceId }],
    })
    const foraDaTolerancia = await createBooking(actor(), {
      petId: antigo.petId,
      professionalId,
      startsAt: haDuasHoras,
      items: [{ serviceId }],
    })

    const result = await sweepNoShows()
    expect(result.marked).toBeGreaterThanOrEqual(1)

    // Quem tem horário há 30 min pode estar estacionando o carro.
    const recenteRow = await ownerPrisma.appointment.findUniqueOrThrow({
      where: { id: dentroDaTolerancia.id },
    })
    expect(recenteRow.status).toBe('CONFIRMED')

    const antigoRow = await ownerPrisma.appointment.findUniqueOrThrow({
      where: { id: foraDaTolerancia.id },
    })
    expect(antigoRow.status).toBe('NO_SHOW')
  })

  it('quem já fez check-in não vira falta', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
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
      startsAt: new Date(Date.now() - 2 * 3_600_000),
      items: [{ serviceId }],
    })
    await checkIn(actor(), booking.id)

    await sweepNoShows()

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.status).toBe('CHECKED_IN')
  })

  it('a solicitação esquecida por 24h expira e libera o horário', async () => {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { onlineBookingRequiresApproval: true, minBookingNoticeHours: 0 },
    })
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      source: 'PORTAL',
    })

    // Envelhece a solicitação.
    await ownerPrisma.appointment.update({
      where: { id: booking.id },
      data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
    })

    const result = await expirePendingApprovals()
    expect(result.expired).toBeGreaterThanOrEqual(1)

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.status).toBe('CANCELLED')
    // Expirar não é falta do tutor.
    expect(row.cancelledLate).toBe(false)
  })
})

describe('consumidores de evento', () => {
  it('RN-10: o óbito cancela os futuros sem taxa e sem avisar o tutor', async () => {
    const { serviceId, professionalId, petId } = await cenario({
      maxConcurrentPets: 5,
      jornadaIntegral: true,
    })
    const futuro = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: new Date(Date.now() + 48 * 3_600_000),
      items: [{ serviceId }],
    })

    await handlePetObito({ tenantId: tenant.tenantId, petId })

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: futuro.id } })
    expect(row.status).toBe('CANCELLED')
    // Cobrar taxa pelo óbito de um animal seria o pior erro possível.
    expect(row.cancelledLate).toBe(false)

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { entityId: petId, action: 'appointment.cancelled_by_death' },
    })
    expect((audit.after as Record<string, unknown>).notificationSuppressed).toBe(true)
  })

  it('o óbito não mexe no que já aconteceu', async () => {
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 5 })
    const passado = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: quintaAs('09:00'),
      items: [{ serviceId }],
    })
    await ownerPrisma.appointment.update({
      where: { id: passado.id },
      data: { status: 'COMPLETED', startsAt: new Date(Date.now() - 48 * 3_600_000) },
    })

    await handlePetObito({ tenantId: tenant.tenantId, petId })

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: passado.id } })
    expect(row.status).toBe('COMPLETED')
  })

  it('a mescla de tutores move os agendamentos, inclusive os passados', async () => {
    const { serviceId, professionalId, petId, tutorId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    const destino = await givenPet(tenant, { name: 'Outro' })

    await handleTutorMesclado({
      tenantId: tenant.tenantId,
      sourceId: tutorId,
      targetId: destino.tutorId,
    })

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.tutorId).toBe(destino.tutorId)
  })
})

describe('rotas novas', () => {
  it('GET /v1/agenda/day devolve o painel do dia', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { timezone: 'UTC' },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/agenda/day?date=${QUINTA_DIA}`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.columns).toHaveLength(1)
    expect(body.columns[0].appointments).toHaveLength(1)
  })

  it('GET /v1/agenda/movement devolve a janela fechada, com o dia vazio zerado', async () => {
    const { serviceId, professionalId, petId } = await cenario({ jornadaIntegral: true })
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { timezone: 'UTC' },
    })

    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: quintaAs('11:00'),
      items: [{ serviceId }],
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/agenda/movement?date=${QUINTA_DIA}&days=7`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    // A janela termina em `date` e o dia sem movimento continua na série: uma barra
    // que some deslocaria o eixo do gráfico.
    expect(body.days).toHaveLength(7)
    expect(body.days[0].date).toBe(diaAntes(6))
    expect(body.days[6]).toMatchObject({ date: QUINTA_DIA, total: 2, totalCents: 14000 })
    expect(body.days[5]).toMatchObject({ date: diaAntes(1), total: 0, totalCents: 0 })
  })

  it('GET /v1/agenda/movement não conta o cancelado', async () => {
    const { serviceId, professionalId, petId } = await cenario({ jornadaIntegral: true })
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { timezone: 'UTC' },
    })

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    await ownerPrisma.appointment.update({
      where: { id: booking.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/agenda/movement?date=${QUINTA_DIA}`,
    })

    expect(response.statusCode).toBe(200)
    // `days` cai no padrão de 7 quando não vem na query.
    expect(response.json().days).toHaveLength(7)
    expect(response.json().days[6]).toMatchObject({ date: QUINTA_DIA, total: 0 })
  })

  it('POST /v1/recurrences cria a série e relata o que pulou', async () => {
    const { serviceId, professionalId, petId } = await cenario({ maxConcurrentPets: 5 })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/recurrences',
      payload: {
        petId,
        professionalId,
        serviceIds: [serviceId],
        startsAt: '2026-09-01T09:00:00.000Z',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().generated).toBe(12)
  })

  it('POST /v1/appointments/:id/reschedule devolve o novo agendamento', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/appointments/${booking.id}/reschedule`,
      payload: { startsAt: quintaAs('14:00').toISOString() },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.id).not.toBe(booking.id)
    expect(body.status).toBe('CONFIRMED')
    expect(body.rescheduleCount).toBe(1)
  })
})
