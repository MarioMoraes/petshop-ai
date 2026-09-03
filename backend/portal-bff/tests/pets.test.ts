import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  asVisitor,
  callApi,
  closeHarness,
  givenAllergy,
  givenAppointment,
  givenAttendance,
  givenPet,
  givenProfessional,
  givenTemperament,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * MOD-PORTAL-03 e 04 — os pets do tutor e a história de cada um.
 *
 * O que esta suíte guarda não é o formato da resposta: é o **recorte**. Quase todo teste
 * aqui existe para provar que uma coisa que está no banco *não* chegou ao tutor — o pet
 * de outra pessoa, a nota interna da equipe, o temperamento reativo, o rascunho de
 * atendimento em andamento. O caminho feliz é o menor deles.
 */

let fixture: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
})

afterAll(async () => {
  await closeHarness()
})

describe('GET /portal/v1/pets', () => {
  it('lista os pets do vínculo ativo com idade e próximo agendamento (AC-01)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId, {
      name: 'Mel',
      birthDate: new Date('2022-03-10T00:00:00Z'),
    })
    const professionalId = await givenProfessional(fixture)
    await givenAppointment(fixture, tutorId, petId, professionalId, {
      startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      serviceLabel: 'Banho e tosa',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/pets',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const { pets } = response.json() as { pets: Record<string, unknown>[] }
    expect(pets).toHaveLength(1)
    expect(pets[0]).toMatchObject({ id: petId, name: 'Mel', inMemoriam: false })
    expect(pets[0]?.ageLabel).toBeTruthy()
    expect(pets[0]?.nextAppointment).toMatchObject({ services: ['Banho e tosa'] })
  })

  it('não traz o pet de outro tutor', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    await givenPet(fixture, theirs, { name: 'Rex' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/pets',
      ...asTutor(fixture, mine),
    })

    expect(response.json()).toEqual({ pets: [] })
  })

  it('some com o pet transferido e mantém o falecido em memória (AC-05)', async () => {
    const tutorId = await givenTutor(fixture)
    await givenPet(fixture, tutorId, { name: 'Transferido', unlinked: true })
    await givenPet(fixture, tutorId, { name: 'Bidu', status: 'DECEASED' })
    await givenPet(fixture, tutorId, { name: 'Aurora' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/pets',
      ...asTutor(fixture, tutorId),
    })

    const { pets } = response.json() as { pets: { name: string; inMemoriam: boolean }[] }
    // Vivos primeiro, e "em memória" fecha a lista.
    expect(pets.map((pet) => pet.name)).toEqual(['Aurora', 'Bidu'])
    expect(pets[1]?.inMemoriam).toBe(true)
  })

  it('não atende quem não tem ficha vinculada', async () => {
    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/pets',
      ...asVisitor(fixture),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('GET /portal/v1/pets/:petId', () => {
  it('traz alergia e alerta médico, e nunca o temperamento (AC-04 de MOD-PORTAL-04)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId, { notes: 'Adora colo' })
    await givenAllergy(fixture, petId, 'Aveia')
    await givenTemperament(fixture, petId)

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, unknown>
    expect(body.alerts).toEqual([{ kind: 'ALLERGY', label: 'Aveia', severity: 'HIGH' }])
    expect(body.notes).toBe('Adora colo')
    expect(JSON.stringify(body)).not.toContain('REACTIVE')
    // Peso, porte, raça e pelagem chegam para a tela mostrar — e não para editar.
    expect(body).toHaveProperty('size')
    expect(body).toHaveProperty('weightKg')
  })

  it('responde 404, e não 403, para o pet de outro tutor (AC-03 de MOD-PORTAL-02)', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs)

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}`,
      ...asTutor(fixture, mine),
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'ERR_PORTAL_001' })
  })
})

describe('PATCH /portal/v1/pets/:petId', () => {
  it('atualiza o que é do tutor e ajusta a precisão da data (AC-02)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)

    const response = await callApi({
      method: 'PATCH',
      url: `/portal/v1/pets/${petId}`,
      ...asTutor(fixture, tutorId),
      payload: { name: 'Mel', birthDate: '2021-07-04', neutered: true, notes: 'Tem medo de secador' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      name: 'Mel',
      birthDate: '2021-07-04',
      birthDatePrecision: 'EXACT',
      neutered: true,
      notes: 'Tem medo de secador',
    })
  })

  it('recusa peso e porte antes de chegar ao handler (AC-03)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId, { weightKg: 8 })

    const response = await callApi({
      method: 'PATCH',
      url: `/portal/v1/pets/${petId}`,
      ...asTutor(fixture, tutorId),
      payload: { weightKg: 4 },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'ERR_PORTAL_007' })

    const after = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}`,
      ...asTutor(fixture, tutorId),
    })
    expect((after.json() as { weightKg: number }).weightKg).toBe(8)
  })

  it('não deixa editar a ficha de quem morreu (AC-05)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId, { status: 'DECEASED' })

    const response = await callApi({
      method: 'PATCH',
      url: `/portal/v1/pets/${petId}`,
      ...asTutor(fixture, tutorId),
      payload: { name: 'Outro nome' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('não deixa um tutor editar o pet de outro', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs, { name: 'Rex' })

    const response = await callApi({
      method: 'PATCH',
      url: `/portal/v1/pets/${petId}`,
      ...asTutor(fixture, mine),
      payload: { name: 'Sequestrado' },
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('GET /portal/v1/pets/:petId/timeline', () => {
  it('traz o que foi feito, com o profissional e as notas visíveis (AC-01)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture, 'Ana Banhista')

    await givenAttendance(fixture, tutorId, petId, professionalId, {
      startedAt: new Date('2026-08-20T13:00:00Z'),
      serviceLabel: 'Banho',
      notes: [
        { body: 'Ficou cheiroso, secou rápido', visibility: 'TUTOR_VISIBLE' },
        { body: 'Tutor discutiu o preço, atenção no próximo', visibility: 'INTERNAL' },
      ],
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}/timeline`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { entries: Record<string, unknown>[] }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({
      professional: 'Ana Banhista',
      services: ['Banho'],
      notes: ['Ficou cheiroso, secou rápido'],
    })
  })

  it('a nota interna não viaja na resposta (AC-02)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)

    await givenAttendance(fixture, tutorId, petId, professionalId, {
      startedAt: new Date('2026-08-20T13:00:00Z'),
      notes: [{ body: 'Tutor discutiu o preço', visibility: 'INTERNAL' }],
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}/timeline`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.body).not.toContain('discutiu o preço')
  })

  it('mostra o atendimento anulado, sem o motivo interno (AC-03)', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)

    await givenAttendance(fixture, tutorId, petId, professionalId, {
      startedAt: new Date('2026-08-18T13:00:00Z'),
      voided: true,
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}/timeline`,
      ...asTutor(fixture, tutorId),
    })

    const body = response.json() as { entries: { voidedAt: string | null }[] }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]?.voidedAt).toBeTruthy()
    expect(response.body).not.toContain('pet errado')
  })

  it('não mostra atendimento em andamento', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)

    await givenAttendance(fixture, tutorId, petId, professionalId, {
      startedAt: new Date(),
      status: 'DRAFT',
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}/timeline`,
      ...asTutor(fixture, tutorId),
    })

    expect((response.json() as { entries: unknown[] }).entries).toEqual([])
  })

  it('pagina do mais recente para o mais antigo', async () => {
    const tutorId = await givenTutor(fixture)
    const petId = await givenPet(fixture, tutorId)
    const professionalId = await givenProfessional(fixture)

    for (const day of ['10', '11', '12']) {
      await givenAttendance(fixture, tutorId, petId, professionalId, {
        startedAt: new Date(`2026-08-${day}T13:00:00Z`),
      })
    }

    const first = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}/timeline?limit=2`,
      ...asTutor(fixture, tutorId),
    })
    const firstBody = first.json() as { entries: { startedAt: string }[]; nextCursor: string | null }
    expect(firstBody.entries.map((entry) => entry.startedAt.slice(8, 10))).toEqual(['12', '11'])
    expect(firstBody.nextCursor).toBeTruthy()

    const second = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}/timeline?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      ...asTutor(fixture, tutorId),
    })
    const secondBody = second.json() as { entries: { startedAt: string }[]; nextCursor: string | null }
    expect(secondBody.entries.map((entry) => entry.startedAt.slice(8, 10))).toEqual(['10'])
    expect(secondBody.nextCursor).toBeNull()
  })

  it('responde 404 para o histórico de um pet que não é dele', async () => {
    const mine = await givenTutor(fixture)
    const theirs = await givenTutor(fixture, { phone: '+5511911112222' })
    const petId = await givenPet(fixture, theirs)

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/pets/${petId}/timeline`,
      ...asTutor(fixture, mine),
    })

    expect(response.statusCode).toBe(404)
  })
})
