import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  callApi,
  checkoutEvent,
  closeHarness,
  givenAppointment,
  givenTenant,
  resetDatabase,
  type TenantFixture,
} from './harness.js'
import {
  handleAtendimentoConcluido,
  handleAtendimentoIniciado,
  handlePetObito,
} from '../src/modules/attendances/consumers.js'

/**
 * MOD-PRONT-01/09/10 — o atendimento.
 *
 * Os testes entram pelo **evento**, e não por um POST, porque é assim que o registro
 * nasce de verdade: a agenda publica, o prontuário escreve. Chamar os handlers
 * diretamente (em vez de subir o RabbitMQ) mantém a suíte determinística sem mentir
 * sobre o caminho — o que se exercita é o mesmo código que o broker chamaria.
 */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

describe('MOD-PRONT-01 — o atendimento nasce do check-out', () => {
  it('AC-01: check-in abre rascunho e check-out fecha com os itens do evento', async () => {
    const appointment = await givenAppointment(tenant)

    await handleAtendimentoIniciado({
      tenantId: tenant.tenantId,
      appointmentId: appointment.appointmentId,
      petId: appointment.petId,
      professionalId: appointment.professionalId,
    })

    const draft = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/attendances?petId=${appointment.petId}`,
    })
    expect(draft.statusCode).toBe(200)
    expect(draft.json().attendances[0]).toMatchObject({ status: 'DRAFT', version: 1 })

    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))

    const list = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/attendances?petId=${appointment.petId}`,
    })
    const [attendance] = list.json().attendances
    expect(attendance).toMatchObject({
      status: 'COMPLETED',
      type: 'BATH',
      origin: 'SCHEDULED',
      totalCents: 8000,
      editable: true,
      weightKg: 12.5,
    })
    // O preço vem congelado do evento (RN-07), não reconsultado do catálogo.
    expect(attendance.items).toHaveLength(1)
    expect(attendance.items[0]).toMatchObject({ label: 'Banho', unitPriceCents: 8000 })
    expect(new Date(attendance.editableUntil).getTime()).toBeGreaterThan(Date.now())
  })

  it('só existe um atendimento por agendamento, por mais vezes que o evento chegue', async () => {
    const appointment = await givenAppointment(tenant)
    const event = checkoutEvent(tenant, appointment)

    await handleAtendimentoConcluido(event)
    await handleAtendimentoConcluido(event)
    await handleAtendimentoConcluido(event)

    const list = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/attendances?petId=${appointment.petId}`,
    })
    expect(list.json().attendances).toHaveLength(1)
    // A reentrega também não pode duplicar os itens dentro do registro.
    expect(list.json().attendances[0].items).toHaveLength(1)
  })

  it('check-out sem check-in cria o registro já concluído — o encaixe e o evento perdido', async () => {
    const appointment = await givenAppointment(tenant, { status: 'COMPLETED' })

    await handleAtendimentoConcluido(
      checkoutEvent(tenant, appointment, { origin: 'WALK_IN' }),
    )

    const list = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/attendances?petId=${appointment.petId}`,
    })
    expect(list.json().attendances[0]).toMatchObject({
      status: 'COMPLETED',
      origin: 'WALK_IN',
    })
  })

  it('AC-02: agendamento apagado entre o check-in e a entrega não estoura o consumidor', async () => {
    await expect(
      handleAtendimentoIniciado({
        tenantId: tenant.tenantId,
        appointmentId: '00000000-0000-4000-8000-000000000000',
        petId: '00000000-0000-4000-8000-000000000001',
        professionalId: '00000000-0000-4000-8000-000000000002',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('MOD-PRONT-09 — imutabilidade e correção', () => {
  it('AC-01: dentro das 24h a observação é corrigida direto', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)

    const patch = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/attendances/${id}`,
      payload: { observations: 'Pet ficou agitado no secador' },
    })

    expect(patch.statusCode).toBe(200)
    expect(patch.json().observations).toBe('Pet ficou agitado no secador')
    // A correção direta não versiona: versão é contador de adendo.
    expect(patch.json().version).toBe(1)
  })

  it('AC-02: passadas as 24h a edição vira 409 ERR_PRONT_006', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)
    await expireWindow(id)

    const patch = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/attendances/${id}`,
      payload: { observations: 'tentativa tardia' },
    })

    expect(patch.statusCode).toBe(409)
    expect(patch.json().code).toBe('ERR_PRONT_006')
  })

  it('AC-02: o adendo passa depois das 24h e incrementa a versão', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)
    await expireWindow(id)

    const addendum = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/attendances/${id}/addendum`,
      payload: { body: 'Correção: o shampoo usado foi o hipoalergênico, não o neutro.' },
    })

    expect(addendum.statusCode).toBe(201)
    expect(addendum.json().version).toBe(2)
    expect(addendum.json().notes).toHaveLength(1)
    expect(addendum.json().notes[0]).toMatchObject({ kind: 'ADDENDUM', version: 2 })
  })

  it('o trigger do banco recusa a escrita fora da janela mesmo por fora da aplicação', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)
    await expireWindow(id)

    await expect(
      withTenant(tenant.tenantId, (tx) =>
        tx.attendance.update({ where: { id }, data: { observationsEncrypted: 'v1:x:x:x' } }),
      ),
    ).rejects.toThrow(/ERR_PRONT_006/)
  })

  it('AC-03: anular não apaga — o registro fica VOIDED com o motivo', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)

    const voided = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/attendances/${id}/void`,
      payload: { reason: 'Registrado no pet errado — refeito na ficha da Mel' },
    })

    expect(voided.statusCode).toBe(200)
    expect(voided.json()).toMatchObject({
      status: 'VOIDED',
      voidReason: 'Registrado no pet errado — refeito na ficha da Mel',
      editable: false,
    })

    const detail = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/attendances/${id}`,
    })
    expect(detail.statusCode).toBe(200)
  })

  it('anular duas vezes é 422 — a segunda anulação não estorna de novo', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)
    const payload = { reason: 'Serviço não chegou a ser executado no dia' }

    await callApi({ ...asAdmin(tenant), method: 'POST', url: `/v1/attendances/${id}/void`, payload })
    const again = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/attendances/${id}/void`,
      payload,
    })

    expect(again.statusCode).toBe(422)
  })

  it('§9: anular exige `record:void` — quem só escreve no prontuário recebe 403', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)

    const denied = await callApi({
      clerkUserId: tenant.clerkUserId,
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      role: 'VET',
      permissions: ['record:read_summary', 'record:write', 'record:write_notes'],
      method: 'POST',
      url: `/v1/attendances/${id}/void`,
      payload: { reason: 'veterinário tentando anular por engano' },
    })

    expect(denied.statusCode).toBe(403)
    expect(denied.json().code).toBe('ERR_PRONT_003')
  })
})

describe('MOD-PRONT-10 — observações durante a execução', () => {
  it('a nota operacional entra no rascunho e não versiona o registro', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoIniciado({
      tenantId: tenant.tenantId,
      appointmentId: appointment.appointmentId,
      petId: appointment.petId,
      professionalId: appointment.professionalId,
    })
    const id = await firstAttendanceId(appointment.petId)

    const note = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/attendances/${id}/notes`,
      payload: { body: 'Não deixou cortar a unha da pata traseira' },
    })

    expect(note.statusCode).toBe(201)
    expect(note.json().version).toBe(1)
    expect(note.json().notes[0]).toMatchObject({
      kind: 'OPERATIONAL',
      visibility: 'INTERNAL',
      body: 'Não deixou cortar a unha da pata traseira',
    })
  })

  it('depois do check-out a nota rápida vira 409 — o caminho é o adendo', async () => {
    const appointment = await givenAppointment(tenant)
    await handleAtendimentoConcluido(checkoutEvent(tenant, appointment))
    const id = await firstAttendanceId(appointment.petId)

    const note = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/attendances/${id}/notes`,
      payload: { body: 'tarde demais' },
    })

    expect(note.statusCode).toBe(409)
    expect(note.json().code).toBe('ERR_PRONT_006')
  })
})

describe('Consumo de `pet.obito`', () => {
  it('encerra os alertas ativos do pet sem apagar o histórico', async () => {
    const appointment = await givenAppointment(tenant)

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${appointment.petId}/allergies`,
      payload: {
        type: 'PRODUCT',
        label: 'Shampoo neutro',
        severity: 'HIGH',
        diagnosedAt: '2026-01-10',
      },
    })

    await handlePetObito({ tenantId: tenant.tenantId, petId: appointment.petId })

    const record = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${appointment.petId}/allergies`,
    })
    expect(record.json()).toHaveLength(1)
    expect(record.json()[0].active).toBe(false)
  })
})

// ─── Apoio ───────────────────────────────────────────────────────────────────

async function firstAttendanceId(petId: string): Promise<string> {
  return withTenant(tenant.tenantId, async (tx) => {
    const row = await tx.attendance.findFirstOrThrow({
      where: { petId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    return row.id
  })
}

/**
 * Empurra a janela de 24h para trás em vez de esperar por ela.
 *
 * A escrita é feita pelo cliente owner de propósito: alterar `editable_until` pela
 * aplicação passaria pelo próprio trigger que o teste quer exercitar depois.
 */
async function expireWindow(id: string): Promise<void> {
  const { ownerPrisma } = await import('./harness.js')
  await ownerPrisma.$executeRaw`UPDATE attendances SET editable_until = now() - interval '1 hour' WHERE id = ${id}::uuid`
}
