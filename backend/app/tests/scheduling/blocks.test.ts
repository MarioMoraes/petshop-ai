import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/** MOD-AGENDA-03 — bloqueios e folgas. */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

async function givenProfessional(displayName = 'Ana') {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/professionals',
    payload: { displayName, roleKey: 'BATHER' },
  })
  return response.json()
}

/** Uma sexta-feira inteira, no fuso do tenant. */
const SEXTA_INICIO = '2026-09-04T03:00:00.000Z'
const SEXTA_FIM = '2026-09-05T03:00:00.000Z'

describe('MOD-AGENDA-03 — bloqueios e folgas', () => {
  it('AC-01: a folga de dia inteiro entra e aparece na consulta do período', async () => {
    const ana = await givenProfessional()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: {
        professionalId: ana.id,
        startsAt: SEXTA_INICIO,
        endsAt: SEXTA_FIM,
        reason: 'Folga',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.scope).toBe('PROFESSIONAL')
    expect(body.reason).toBe('Folga')

    const lista = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/calendar-blocks?from=${SEXTA_INICIO}&to=${SEXTA_FIM}`,
    })
    expect(lista.json()).toHaveLength(1)
  })

  it('AC-02: bloqueio sobre agendamento existente falha com a lista dos afetados', async () => {
    const ana = await givenProfessional()

    const { setAppointmentsPort } = await import('../../src/modules/schedule-catalog/port.js')
    const afetados = [
      { id: '11111111-1111-4111-8111-111111111111', startsAt: new Date(SEXTA_INICIO), petName: 'Thor' },
      { id: '22222222-2222-4222-8222-222222222222', startsAt: new Date(SEXTA_INICIO), petName: 'Mel' },
      { id: '33333333-3333-4333-8333-333333333333', startsAt: new Date(SEXTA_INICIO), petName: 'Bidu' },
      { id: '44444444-4444-4444-8444-444444444444', startsAt: new Date(SEXTA_INICIO), petName: 'Nina' },
    ]
    setAppointmentsPort({
      countByService: async () => 0,
      listByProfessional: async () => [],
      listInWindow: async () => afetados,
      cancelBatch: async () => undefined,
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: { professionalId: ana.id, startsAt: SEXTA_INICIO, endsAt: SEXTA_FIM },
    })

    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.code).toBe('ERR_AGENDA_012')
    expect(body.appointments).toHaveLength(4)

    // Falhou de verdade: nenhum bloqueio foi gravado.
    const blocos = await ownerPrisma.calendarBlock.findMany({ where: { tenantId: tenant.tenantId } })
    expect(blocos).toHaveLength(0)
  })

  it('AC-02: reenviar com CANCEL cria o bloqueio e cancela os agendamentos em lote', async () => {
    const ana = await givenProfessional()

    const { setAppointmentsPort } = await import('../../src/modules/schedule-catalog/port.js')
    const cancelados: string[][] = []
    setAppointmentsPort({
      countByService: async () => 0,
      listByProfessional: async () => [],
      listInWindow: async () => [
        { id: '11111111-1111-4111-8111-111111111111', startsAt: new Date(SEXTA_INICIO), petName: 'Thor' },
      ],
      cancelBatch: async (_tx, ids) => {
        cancelados.push(ids)
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: {
        professionalId: ana.id,
        startsAt: SEXTA_INICIO,
        endsAt: SEXTA_FIM,
        reason: 'Folga',
        onConflict: 'CANCEL',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().cancelledAppointmentIds).toHaveLength(1)
    expect(cancelados).toEqual([['11111111-1111-4111-8111-111111111111']])
  })

  it('AC-03: o feriado do tenant não tem profissional e vale para todos', async () => {
    const ana = await givenProfessional()
    const carlos = await givenProfessional('Carlos')

    const feriado = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: { startsAt: SEXTA_INICIO, endsAt: SEXTA_FIM, reason: 'Feriado' },
    })

    expect(feriado.statusCode).toBe(201)
    expect(feriado.json().scope).toBe('TENANT')
    expect(feriado.json().professionalId).toBeNull()

    // A consulta por profissional traz o feriado junto: ele bloqueia os dois.
    for (const profissional of [ana, carlos]) {
      const lista = await callApi({
        ...asAdmin(tenant),
        method: 'GET',
        url: `/v1/calendar-blocks?from=${SEXTA_INICIO}&to=${SEXTA_FIM}&professionalId=${profissional.id}`,
      })
      expect(lista.json()).toHaveLength(1)
      expect(lista.json()[0].scope).toBe('TENANT')
    }
  })

  it('a consulta usa sobreposição, não contenção: bloqueio longo aparece em qualquer dia dele', async () => {
    const ana = await givenProfessional()

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: {
        professionalId: ana.id,
        startsAt: '2026-09-01T03:00:00.000Z',
        endsAt: '2026-09-08T03:00:00.000Z',
        reason: 'Férias',
      },
    })

    // Um único dia no meio das férias.
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/calendar-blocks?from=${SEXTA_INICIO}&to=${SEXTA_FIM}`,
    })

    expect(response.json()).toHaveLength(1)
  })

  it('recusa bloqueio que termina antes de começar', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: { startsAt: SEXTA_FIM, endsAt: SEXTA_INICIO },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_AGENDA_002')
  })

  it('remove o bloqueio e registra na trilha', async () => {
    const ana = await givenProfessional()
    const bloco = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/calendar-blocks',
        payload: { professionalId: ana.id, startsAt: SEXTA_INICIO, endsAt: SEXTA_FIM },
      })
    ).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/calendar-blocks/${bloco.id}`,
    })

    expect(response.statusCode).toBe(204)

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { entityId: bloco.id, action: 'calendar_block.deleted' },
    })
    expect(audit).not.toBeNull()
  })

  it('a recepção lê os bloqueios, mas não os cria (§9)', async () => {
    const leitura = await callApi({
      ...(await asReceptionist(tenant)),
      method: 'GET',
      url: `/v1/calendar-blocks?from=${SEXTA_INICIO}&to=${SEXTA_FIM}`,
    })
    expect(leitura.statusCode).toBe(200)

    const escrita = await callApi({
      ...(await asReceptionist(tenant)),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: { startsAt: SEXTA_INICIO, endsAt: SEXTA_FIM },
    })
    expect(escrita.statusCode).toBe(403)
  })

  it('não enxerga bloqueio de outro tenant', async () => {
    const ana = await givenProfessional()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/calendar-blocks',
      payload: { professionalId: ana.id, startsAt: SEXTA_INICIO, endsAt: SEXTA_FIM },
    })

    const outro = await givenTenant('Outro Petshop')
    const response = await callApi({
      ...asAdmin(outro),
      method: 'GET',
      url: `/v1/calendar-blocks?from=${SEXTA_INICIO}&to=${SEXTA_FIM}`,
    })

    expect(response.json()).toHaveLength(0)
  })
})
