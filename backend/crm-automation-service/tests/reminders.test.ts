import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { sendAppointmentReminders } from '../src/modules/crm/reminders.js'
import {
  handleAgendamentoCancelado,
  handleAgendamentoCriado,
  handleAgendamentoReagendado,
} from '../src/modules/crm/consumers.js'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenAppointment,
  givenTenant,
  installFakeMessagingPort,
  resetDatabase,
  type FakeMessaging,
  type TenantFixture,
} from './harness.js'

/** MOD-CRM-05 — o lembrete, e o que o cancela. */

let fixture: TenantFixture
let messaging: FakeMessaging

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  messaging = installFakeMessagingPort()
})

afterAll(closeHarness)

describe('varredura de lembretes (AC-01)', () => {
  it('enfileira o lembrete do agendamento que entra na janela de 24h', async () => {
    const appointment = await givenAppointment(fixture, { hoursFromNow: 24.5 })

    const summary = await sendAppointmentReminders()

    expect(summary.enqueued).toBe(1)
    const request = messaging.requests[0]!
    expect(request.tutorId).toBe(appointment.tutorId)
    expect(request.templateKey).toBe('appointment_reminder')
    expect(request.dedupeKey).toBe(`reminder:${appointment.appointmentId}`)
    expect(request.originType).toBe('APPOINTMENT')
    // Data e hora já formatadas no fuso do tenant — o template não sabe de fuso.
    expect(request.variables['agendamento.hora']).toMatch(/^\d{2}:\d{2}$/)
    expect(request.variables['pets.lista']).toBe('Thor')
    expect(request.variables['agendamento.servico']).toBe('Banho')
  })

  it('ignora o que está fora da janela', async () => {
    // Daqui a três dias: ainda não é hora de lembrar.
    await givenAppointment(fixture, { hoursFromNow: 72 })
    // Daqui a duas horas: o lembrete de 24h já passou — a confirmação cobriu (AC-03).
    await givenAppointment(fixture, { hoursFromNow: 2 })

    const summary = await sendAppointmentReminders()

    expect(summary.enqueued).toBe(0)
  })

  it('não duplica quando a varredura roda duas vezes (a chave é o agendamento)', async () => {
    const appointment = await givenAppointment(fixture, { hoursFromNow: 24.5 })

    await sendAppointmentReminders()
    await sendAppointmentReminders()

    // Duas passadas, duas chamadas — mas a **mesma** chave, e é o messaging-service que
    // devolve a existente. A idempotência mora lá, e é testada lá.
    expect(new Set(messaging.requests.map((request) => request.dedupeKey)).size).toBe(1)
    void appointment
  })

  it('junta os pets do mesmo tutor no mesmo horário numa mensagem só (AC-05)', async () => {
    const first = await givenAppointment(fixture, { hoursFromNow: 24.5, petName: 'Thor' })
    // Segundo pet, mesmo tutor, mesmo instante.
    const startsAt = await withTenant(fixture.tenantId, async (tx) => {
      const row = await tx.appointment.findUniqueOrThrow({
        where: { id: first.appointmentId },
        select: { startsAt: true },
      })
      return row.startsAt
    })

    const second = await givenAppointment(fixture, {
      hoursFromNow: 24.5,
      tutorId: first.tutorId,
      petName: 'Mel',
    })
    await withTenant(fixture.tenantId, (tx) =>
      tx.appointment.update({
        where: { id: second.appointmentId },
        data: { startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) },
      }),
    )

    await sendAppointmentReminders()

    // Três mensagens seguidas para o mesmo número é o que faz o cliente bloquear o
    // petshop: os nomes entram na mesma frase.
    expect(messaging.requests[0]!.variables['pets.lista']).toBe('Thor e Mel')
  })

  it('não enfileira nada com a automação desligada', async () => {
    await givenAppointment(fixture, { hoursFromNow: 24.5 })

    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/crm/automations/appointment_reminder',
      payload: { enabled: false },
    })

    const summary = await sendAppointmentReminders()
    expect(summary.enqueued).toBe(0)
  })

  it('respeita o leadHours configurado', async () => {
    await givenAppointment(fixture, { hoursFromNow: 48.5 })

    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/crm/automations/appointment_reminder',
      payload: { config: { leadHours: 48 } },
    })

    const summary = await sendAppointmentReminders()
    expect(summary.enqueued).toBe(1)
  })

  it('conta como pulado — e não estoura — quando o messaging está fora', async () => {
    await givenAppointment(fixture, { hoursFromNow: 24.5 })
    messaging.failNext()

    const summary = await sendAppointmentReminders()

    // A varredura da hora seguinte reenfileira; o dedupeKey impede a duplicata.
    expect(summary.skipped).toBe(1)
    expect(summary.enqueued).toBe(0)
  })
})

describe('reação a eventos (§8)', () => {
  it('manda a confirmação quando o agendamento nasce', async () => {
    const appointment = await givenAppointment(fixture, { hoursFromNow: 48 })

    await handleAgendamentoCriado({
      tenantId: fixture.tenantId,
      appointmentId: appointment.appointmentId,
    })

    expect(messaging.requests).toHaveLength(1)
    expect(messaging.requests[0]!.templateKey).toBe('appointment_confirmed')
  })

  it('cancela o lembrete pendente quando o agendamento é cancelado (AC-06 de MOD-CRM-03)', async () => {
    const appointment = await givenAppointment(fixture, { hoursFromNow: 24.5 })

    // Um lembrete já esperando na fila do messaging.
    const messageId = await withTenant(fixture.tenantId, async (tx) => {
      const tutor = await tx.tutor.findFirstOrThrow({ select: { id: true } })
      const created = await tx.message.create({
        data: {
          tenantId: fixture.tenantId,
          tutorId: tutor.id,
          channel: 'EMAIL',
          category: 'TRANSACTIONAL',
          templateKey: 'appointment_reminder',
          toEncrypted: 'x',
          toHash: 'h'.repeat(64),
          bodyEncrypted: 'x',
          status: 'SCHEDULED',
          dedupeKey: `reminder:${appointment.appointmentId}`,
          originType: 'APPOINTMENT',
          originId: appointment.appointmentId,
          scheduledFor: new Date(Date.now() + 3_600_000),
        },
        select: { id: true },
      })
      return created.id
    })

    await handleAgendamentoCancelado({
      tenantId: fixture.tenantId,
      appointmentId: appointment.appointmentId,
    })

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: messageId } }),
    )
    // Mandar "seu banho é amanhã" de um horário cancelado é pior que não mandar nada.
    expect(message.status).toBe('CANCELLED')
  })

  it('não avisa o cancelamento com a automação desligada (que é o padrão)', async () => {
    const appointment = await givenAppointment(fixture, { hoursFromNow: 24.5 })

    await handleAgendamentoCancelado({
      tenantId: fixture.tenantId,
      appointmentId: appointment.appointmentId,
    })

    expect(messaging.requests).toHaveLength(0)
  })

  it('no reagendamento cancela o lembrete e não manda aviso contraditório', async () => {
    const appointment = await givenAppointment(fixture, { hoursFromNow: 24.5 })

    await handleAgendamentoReagendado({
      tenantId: fixture.tenantId,
      appointmentId: appointment.appointmentId,
    })

    // O `agendamento.criado` do registro novo é que dispara a confirmação.
    expect(messaging.requests).toHaveLength(0)
  })
})

describe('automações (§5)', () => {
  it('entrega os padrões a um tenant que nunca configurou nada', async () => {
    const response = await callApi({ ...asAdmin(fixture), method: 'GET', url: '/v1/crm/automations' })

    expect(response.statusCode).toBe(200)
    const automations = response.json().data as { key: string; enabled: boolean; isDefault: boolean }[]

    const rows = await withTenant(fixture.tenantId, (tx) => tx.automation.count())
    expect(rows).toBe(0)

    const reminder = automations.find((item) => item.key === 'appointment_reminder')!
    expect(reminder.enabled).toBe(true)
    expect(reminder.isDefault).toBe(true)
    // "Pet pronto" nasce desligada: ninguém decidiu mandá-la ainda.
    expect(automations.find((item) => item.key === 'service_done')!.enabled).toBe(false)
  })

  it('recusa config que não bate com a chave', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/crm/automations/appointment_reminder',
      payload: { config: { leadHours: 999 } },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_CRM_006')
  })

  it('recusa automação que não existe', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/crm/automations/nao_existe',
      payload: { enabled: false },
    })

    expect(response.statusCode).toBe(404)
  })
})
