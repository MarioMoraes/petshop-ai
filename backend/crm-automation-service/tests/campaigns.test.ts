import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { runInactiveCampaign } from '../src/modules/crm/inactive.js'
import {
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  enableAutomation,
  givenTenant,
  givenTutorWithPet,
  installFakeMessagingPort,
  resetDatabase,
  type FakeMessaging,
  type TenantFixture,
} from './harness.js'

/** MOD-CRM-07 e MOD-CRM-12 — campanhas. */

let fixture: TenantFixture
let messaging: FakeMessaging

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  messaging = installFakeMessagingPort()
})

afterAll(closeHarness)

function at10am(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T13:00:00Z`)
}

async function createCampaign(body: Record<string, unknown> = {}) {
  const response = await callApi({
    ...asAdmin(fixture),
    method: 'POST',
    url: '/v1/crm/campaigns',
    payload: {
      name: 'Promoção de setembro',
      templateKey: 'campaign_broadcast',
      ...body,
    },
  })
  return response
}

describe('campanha manual — a prévia (AC-01 de MOD-CRM-12)', () => {
  it('conta quem recebe, quem é pulado e por quê', async () => {
    await givenTutorWithPet(fixture, { name: 'Ana Elegível' })
    await givenTutorWithPet(fixture, { name: 'Bruno Devedor', balanceCents: -5000 })
    await givenTutorWithPet(fixture, { name: 'Carla Sem Opt-in', marketing: false })
    await givenTutorWithPet(fixture, { name: 'Davi Sem Pet', petStatus: 'DECEASED' })

    const created = await createCampaign()
    const campaignId = created.json().id

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/preview`,
    })

    expect(response.statusCode).toBe(200)
    const preview = response.json()
    expect(preview.targeted).toBe(4)
    expect(preview.eligible).toBe(1)
    expect(preview.skipped).toBe(3)
    expect(preview.skippedByReason).toMatchObject({
      HAS_DEBT: 1,
      NO_CONSENT: 1,
      PET_DECEASED: 1,
    })
    // A amostra é só de quem vai receber.
    expect(preview.sample).toHaveLength(1)
    expect(preview.sample[0].name).toBe('Ana Elegível')
  })

  it('a prévia é do instante — o segmento não fica congelado', async () => {
    const tutor = await givenTutorWithPet(fixture, { name: 'Ana Elegível' })
    const created = await createCampaign()
    const campaignId = created.json().id

    const before = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/preview`,
    })
    expect(before.json().eligible).toBe(1)

    // A pessoa fica devendo entre uma prévia e a outra.
    await withTenant(fixture.tenantId, (tx) =>
      tx.tutor.update({ where: { id: tutor.tutorId }, data: { balanceCents: -3000 } }),
    )

    const after = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/preview`,
    })
    expect(after.json().eligible).toBe(0)
    expect(after.json().skippedByReason).toMatchObject({ HAS_DEBT: 1 })
  })
})

describe('campanha manual — o disparo', () => {
  it('exige a contagem confirmada e devolve 409 quando ela mudou (AC-02)', async () => {
    await givenTutorWithPet(fixture, { name: 'Ana Elegível' })
    const created = await createCampaign()
    const campaignId = created.json().id

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/run`,
      payload: { expectedTargets: 99 },
    })

    expect(response.statusCode).toBe(409)
    const problem = response.json()
    expect(problem.expectedTargets).toBe(99)
    expect(problem.actualTargets).toBe(1)
    expect(messaging.requests).toHaveLength(0)
  })

  it('dispara quando a contagem bate, e grava uma linha para cada alvo', async () => {
    await givenTutorWithPet(fixture, { name: 'Ana Elegível' })
    await givenTutorWithPet(fixture, { name: 'Bruno Devedor', balanceCents: -5000 })

    const created = await createCampaign()
    const campaignId = created.json().id

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/run`,
      payload: { expectedTargets: 1 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ targeted: 2, sent: 1, skipped: 1, failed: 0 })
    expect(messaging.requests).toHaveLength(1)

    const targets = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: `/v1/crm/runs/${response.json().runId}/targets`,
    })
    const rows = targets.json().data
    expect(rows).toHaveLength(2)
    // O pulado também tem linha: é a prestação de contas da campanha.
    expect(rows.find((row: { tutorName: string }) => row.tutorName === 'Bruno Devedor')).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'HAS_DEBT',
    })
  })

  it('registra como SKIPPED o que o motor devolveu bloqueado', async () => {
    await givenTutorWithPet(fixture, { name: 'Ana Elegível' })
    const created = await createCampaign()
    const campaignId = created.json().id

    // A supressão é do motor: a classificação daqui não a enxerga, e ela volta no
    // `blockReason`.
    messaging.blockNext('SUPPRESSED')

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/run`,
      payload: { expectedTargets: 1 },
    })

    expect(response.json()).toMatchObject({ sent: 0, skipped: 1 })
    const targets = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: `/v1/crm/runs/${response.json().runId}/targets`,
    })
    expect(targets.json().data[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'SUPPRESSED' })
  })

  it('não dispara duas vezes a mesma campanha', async () => {
    await givenTutorWithPet(fixture, { name: 'Ana Elegível' })
    const created = await createCampaign()
    const campaignId = created.json().id

    await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/run`,
      payload: { expectedTargets: 1 },
    })

    const second = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/run`,
      payload: { expectedTargets: 1 },
    })

    expect(second.statusCode).toBe(409)
  })

  it('recusa segmento que não alcança ninguém', async () => {
    const created = await createCampaign()
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${created.json().id}/run`,
      payload: { expectedTargets: 0 },
    })

    expect(response.statusCode).toBe(422)
  })
})

describe('campanha manual — as guardas', () => {
  it('só aceita texto de marketing', async () => {
    const response = await createCampaign({ templateKey: 'appointment_reminder' })

    expect(response.statusCode).toBe(422)
  })

  it('recusa texto que não existe', async () => {
    const response = await createCampaign({ templateKey: 'nao_existe' })

    expect(response.statusCode).toBe(422)
  })

  it('a recepção vê as campanhas mas não dispara nenhuma', async () => {
    const created = await createCampaign()

    const list = await callApi({ ...asReceptionist(fixture), method: 'GET', url: '/v1/crm/campaigns' })
    expect(list.statusCode).toBe(200)

    const run = await callApi({
      ...asReceptionist(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${created.json().id}/run`,
      payload: { expectedTargets: 0 },
    })
    expect(run.statusCode).toBe(403)
  })

  it('não enxerga a campanha do vizinho', async () => {
    const created = await createCampaign()
    const other = await givenTenant('Outro Petshop')

    const response = await callApi({
      ...asAdmin(other),
      method: 'GET',
      url: `/v1/crm/campaigns/${created.json().id}`,
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('cancelamento (AC-03 de MOD-CRM-12)', () => {
  it('encerra a campanha e não desfaz o que já saiu', async () => {
    await givenTutorWithPet(fixture, { name: 'Ana Elegível' })
    const created = await createCampaign()
    const campaignId = created.json().id

    await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/run`,
      payload: { expectedTargets: 1 },
    })

    const cancel = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: `/v1/crm/campaigns/${campaignId}/cancel`,
    })

    expect(cancel.statusCode).toBe(200)
    const after = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: `/v1/crm/campaigns/${campaignId}`,
    })
    expect(after.json().status).toBe('CANCELLED')
    // A mensagem já foi pedida ao motor: cancelar a campanha não a desfaz.
    expect(messaging.requests).toHaveLength(1)
  })
})

describe('campanha de inativos (MOD-CRM-07)', () => {
  it('convida quem não aparece há mais tempo que o limite (AC-01)', async () => {
    await enableAutomation(fixture, 'inactive_campaign', {
      sendHour: 10,
      inactiveDays: 90,
      cooldownDays: 60,
    })
    const forgotten = await givenTutorWithPet(fixture, {
      name: 'Ana Sumida',
      lastAttendanceDaysAgo: 120,
    })
    await givenTutorWithPet(fixture, { name: 'Bruno Assíduo', lastAttendanceDaysAgo: 10 })

    const summary = await runInactiveCampaign(at10am())

    expect(summary.enqueued).toBe(1)
    const request = messaging.requests[0]!
    expect(request.tutorId).toBe(forgotten.tutorId)
    expect(request.templateKey).toBe('winback')
    expect(request.originType).toBe('CAMPAIGN_RUN')
    expect(request.variables['pets.lista']).toMatch(/^Rex /)
  })

  it('não convide de volta quem tem valor em aberto (AC-05)', async () => {
    await enableAutomation(fixture, 'inactive_campaign', { sendHour: 10, inactiveDays: 90 })
    await givenTutorWithPet(fixture, {
      name: 'Ana Devedora',
      lastAttendanceDaysAgo: 120,
      balanceCents: -5000,
    })

    const summary = await runInactiveCampaign(at10am())

    expect(summary.enqueued).toBe(0)
    expect(messaging.requests).toHaveLength(0)
  })

  it('não convida quem já marcou horário (AC-03)', async () => {
    await enableAutomation(fixture, 'inactive_campaign', { sendHour: 10, inactiveDays: 90 })
    const tutor = await givenTutorWithPet(fixture, {
      name: 'Ana Voltou',
      lastAttendanceDaysAgo: 120,
    })

    // Marcou ontem para semana que vem: `last_attendance_at` ainda não se moveu, porque
    // ele só anda no check-out.
    await withTenant(fixture.tenantId, async (tx) => {
      const professional = await tx.professional.create({
        data: { tenantId: fixture.tenantId, displayName: 'Bruna', roleKey: 'GROOMER' },
        select: { id: true },
      })
      const startsAt = new Date(Date.now() + 7 * 24 * 3_600_000)
      await tx.appointment.create({
        data: {
          tenantId: fixture.tenantId,
          petId: tutor.petId,
          tutorId: tutor.tutorId,
          professionalId: professional.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          status: 'CONFIRMED',
          totalCents: BigInt(8000),
        },
      })
    })

    const summary = await runInactiveCampaign(at10am())

    expect(summary.enqueued).toBe(0)
  })

  it('não repete dentro da carência (AC-02)', async () => {
    await enableAutomation(fixture, 'inactive_campaign', {
      sendHour: 10,
      inactiveDays: 90,
      cooldownDays: 60,
    })
    await givenTutorWithPet(fixture, { name: 'Ana Sumida', lastAttendanceDaysAgo: 120 })

    const first = await runInactiveCampaign(at10am())
    expect(first.enqueued).toBe(1)

    const second = await runInactiveCampaign(at10am())
    expect(second.enqueued).toBe(0)
    expect(second.skipped).toBe(1)
  })

  it('reaproveita a mesma campanha de sistema a cada passada', async () => {
    await enableAutomation(fixture, 'inactive_campaign', { sendHour: 10, inactiveDays: 90 })
    await givenTutorWithPet(fixture, { name: 'Ana Sumida', lastAttendanceDaysAgo: 120 })

    await runInactiveCampaign(at10am())
    await runInactiveCampaign(at10am())

    const campaigns = await withTenant(fixture.tenantId, (tx) =>
      tx.campaign.findMany({ where: { type: 'INACTIVE' }, include: { runs: true } }),
    )
    expect(campaigns).toHaveLength(1)
    expect(campaigns[0]!.runs.length).toBe(2)
    // Volta a SCHEDULED: a reativação não acaba enquanto a automação estiver ligada.
    expect(campaigns[0]!.status).toBe('SCHEDULED')
  })

  it('nasce desligada', async () => {
    await givenTutorWithPet(fixture, { name: 'Ana Sumida', lastAttendanceDaysAgo: 120 })

    const summary = await runInactiveCampaign(at10am())

    expect(summary.tenants).toBe(0)
  })
})
