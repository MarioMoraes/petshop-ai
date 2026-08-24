import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  givenBusinessHours,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/** MOD-AGENDA-02 — profissionais e jornada. */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

async function givenProfessional(overrides: Record<string, unknown> = {}) {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/professionals',
    payload: { displayName: 'Ana', roleKey: 'BATHER', maxConcurrentPets: 3, ...overrides },
  })
  expect(response.statusCode).toBe(201)
  return response.json()
}

/** Seg a sex 08:00–12:00 e 13:00–18:00; sábado 08:00–13:00. O almoço parte o dia. */
const JORNADA = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startsAtMin: 480, endsAtMin: 720 },
    { weekday, startsAtMin: 780, endsAtMin: 1080 },
  ]),
  { weekday: 6, startsAtMin: 480, endsAtMin: 780 },
]

describe('MOD-AGENDA-02 — profissionais e jornada', () => {
  it('AC-01: cria a banhista com capacidade paralela e grava a jornada da semana', async () => {
    const ana = await givenProfessional()
    expect(ana.maxConcurrentPets).toBe(3)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PUT',
      url: `/v1/professionals/${ana.id}/schedule`,
      payload: { windows: JORNADA },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.schedule).toHaveLength(11)
    // O almoço não é um campo: é o vão entre as duas faixas de segunda.
    const segunda = body.schedule.filter((w: { weekday: number }) => w.weekday === 1)
    expect(segunda).toHaveLength(2)
    expect(segunda[0].endsAtMin).toBe(720)
    expect(segunda[1].startsAtMin).toBe(780)
  })

  it('AC-01: capacidade padrão é 1 — quem não configura atende um pet por vez', async () => {
    const carlos = await givenProfessional({ displayName: 'Carlos', maxConcurrentPets: undefined })
    expect(carlos.maxConcurrentPets).toBe(1)
  })

  it('AC-02: jornada que termina antes de começar é 422 com a mensagem do PRD', async () => {
    const ana = await givenProfessional()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PUT',
      url: `/v1/professionals/${ana.id}/schedule`,
      payload: { windows: [{ weekday: 1, startsAtMin: 1080, endsAtMin: 480 }] },
    })

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.code).toBe('ERR_AGENDA_002')
    expect(body.detail).toBe('O horário de término deve ser depois do início')
  })

  it('AC-03: jornada além do horário do tenant é aceita e apenas avisa', async () => {
    await givenBusinessHours(tenant, {
      monday: { open: '08:00', close: '18:00' },
      tuesday: { open: '08:00', close: '18:00' },
    })
    const vet = await givenProfessional({ displayName: 'Dra. Marina', roleKey: 'VET' })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PUT',
      url: `/v1/professionals/${vet.id}/schedule`,
      // Emergência até as 20:00 — depois do fechamento.
      payload: { windows: [{ weekday: 1, startsAtMin: 480, endsAtMin: 1200 }] },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0]).toContain('segunda')
    // Aceita de verdade: a faixa está gravada, não descartada.
    expect(body.schedule[0].endsAtMin).toBe(1200)
  })

  it('AC-03: jornada dentro do horário não gera aviso', async () => {
    await givenBusinessHours(tenant, { monday: { open: '08:00', close: '18:00' } })
    const ana = await givenProfessional()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PUT',
      url: `/v1/professionals/${ana.id}/schedule`,
      payload: { windows: [{ weekday: 1, startsAtMin: 480, endsAtMin: 1080 }] },
    })

    expect(response.json().warnings).toHaveLength(0)
  })

  it('AC-04: desligar quem tem agendamento futuro é 409 com a lista dos afetados', async () => {
    const ana = await givenProfessional()

    const { setAppointmentsPort } = await import('../src/modules/catalog/port.js')
    setAppointmentsPort({
      countByService: async () => 0,
      listByProfessional: async () => [
        { id: '11111111-1111-4111-8111-111111111111', startsAt: new Date('2026-09-01T12:00:00Z'), petName: 'Thor' },
        { id: '22222222-2222-4222-8222-222222222222', startsAt: new Date('2026-09-02T12:00:00Z'), petName: 'Mel' },
      ],
      listInWindow: async () => [],
      cancelBatch: async () => undefined,
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/professionals/${ana.id}`,
      payload: { active: false },
    })

    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.code).toBe('ERR_AGENDA_012')
    expect(body.appointments).toHaveLength(2)
    expect(body.appointments[0].petName).toBe('Thor')

    // A desativação não concluiu: ela continua ativa.
    const linha = await ownerPrisma.professional.findUniqueOrThrow({ where: { id: ana.id } })
    expect(linha.active).toBe(true)
  })

  it('AC-04: sem agendamento futuro, o desligamento passa', async () => {
    const ana = await givenProfessional()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/professionals/${ana.id}`,
      payload: { active: false },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().active).toBe(false)
  })

  it('recusa faixas sobrepostas no mesmo dia', async () => {
    const ana = await givenProfessional()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PUT',
      url: `/v1/professionals/${ana.id}/schedule`,
      payload: {
        windows: [
          { weekday: 1, startsAtMin: 480, endsAtMin: 720 },
          { weekday: 1, startsAtMin: 700, endsAtMin: 1080 },
        ],
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toContain('sobrepostas')
  })

  it('a habilitação é substituída inteira — dá para remover a última', async () => {
    const ana = await givenProfessional()
    const servico = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/services',
        payload: { name: 'Tosa', category: 'GROOMING', baseDurationMin: 60 },
      })
    ).json()

    const habilitado = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/professionals/${ana.id}`,
      payload: { serviceIds: [servico.id] },
    })
    expect(habilitado.json().serviceIds).toEqual([servico.id])

    const removido = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/professionals/${ana.id}`,
      payload: { serviceIds: [] },
    })
    expect(removido.json().serviceIds).toEqual([])
  })

  it('a recepção lê os profissionais, mas não os edita (§9)', async () => {
    const ana = await givenProfessional()

    const leitura = await callApi({
      ...asReceptionist(tenant),
      method: 'GET',
      url: '/v1/professionals',
    })
    expect(leitura.statusCode).toBe(200)

    const escrita = await callApi({
      ...asReceptionist(tenant),
      method: 'PATCH',
      url: `/v1/professionals/${ana.id}`,
      payload: { maxConcurrentPets: 5 },
    })
    expect(escrita.statusCode).toBe(403)
  })

  it('não enxerga profissional de outro tenant', async () => {
    await givenProfessional()
    const outro = await givenTenant('Outro Petshop')

    const response = await callApi({ ...asAdmin(outro), method: 'GET', url: '/v1/professionals' })
    expect(response.json()).toHaveLength(0)
  })
})
