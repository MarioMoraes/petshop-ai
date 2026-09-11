import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { NOVOS_AGENDAMENTOS_JANELA_DIAS } from '@petshop/shared-types'
import { createBooking } from '../../src/modules/scheduling/booking.js'
import { cancel } from '../../src/modules/scheduling/transitions.js'
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
} from './fixtures.js'

/**
 * `GET /v1/appointments/portal-new-count` — o aviso de agendamento novo pelo Portal.
 *
 * A irmã de `pending-count`, e o oposto dela. Aquela conta o que espera decisão e zera
 * quando alguém decide; esta conta o que **já está marcado**, e por isso é a única
 * fonte do sino com marca de lido (`memberships.portal_bookings_seen_at`).
 *
 * O que os casos abaixo protegem é sobretudo o que a contagem **não** conta: o
 * agendamento de balcão, o que espera aprovação e o que foi desmarcado. Cada um deles
 * faria o sino mentir de um jeito diferente.
 */

/** Distante o bastante para nenhum gate de antecedência recusar. */
function quintaDistante(): Date {
  const dia = new Date()
  dia.setUTCHours(9, 0, 0, 0)
  dia.setUTCDate(dia.getUTCDate() + 35)
  return dia
}

const FUTURO = quintaDistante()
const FUTURO_DIA = FUTURO.toISOString().slice(0, 10)

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function actor() {
  return { tenantId: tenant.tenantId, actorUserId: tenant.userId }
}

async function cenario() {
  const serviceId = await givenService(tenant, { durationMin: 60, priceCents: 7000 })
  const professionalId = await givenProfessional(tenant, {
    serviceIds: [serviceId],
    maxConcurrentPets: 4,
  })
  const { petId } = await givenPet(tenant)
  return { serviceId, professionalId, petId }
}

/**
 * Envelhece uma linha à força.
 *
 * `created_at` tem default no banco e nenhuma rota o escreve — sem isto, todo teste de
 * janela precisaria esperar dias. É escrita pelo cliente dono, fora do caminho da
 * aplicação, justamente por ser cenário e não comportamento.
 */
async function criadoEm(appointmentId: string, quando: Date) {
  await ownerPrisma.appointment.update({
    where: { id: appointmentId },
    data: { createdAt: quando },
  })
}

function diasAtras(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

async function contar(since?: string) {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'GET',
    url: `/v1/appointments/portal-new-count${since ? `?since=${encodeURIComponent(since)}` : ''}`,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { count: number; nextDate: string | null }
}

describe('o aviso de agendamento novo pelo Portal', () => {
  it('conta o que nasceu depois da marca e ignora o que veio antes', async () => {
    const { serviceId, professionalId, petId } = await cenario()

    const antigo = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await criadoEm(antigo.id, diasAtras(2))

    const novo = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: new Date(FUTURO.getTime() + 2 * 60 * 60 * 1000),
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await criadoEm(novo.id, diasAtras(0))

    // A marca: "vi tudo até ontem".
    const { count } = await contar(diasAtras(1).toISOString())
    expect(count).toBe(1)
  })

  it('sem marca, conta a janela de novidade e não a agenda inteira', async () => {
    const { serviceId, professionalId, petId } = await cenario()

    const dentro = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await criadoEm(dentro.id, diasAtras(NOVOS_AGENDAMENTOS_JANELA_DIAS - 1))

    const velho = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: new Date(FUTURO.getTime() + 2 * 60 * 60 * 1000),
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await criadoEm(velho.id, diasAtras(NOVOS_AGENDAMENTOS_JANELA_DIAS + 1))

    /*
     * Quem nunca abriu o sino não tem marca, e "desde sempre" faria a primeira
     * abertura de um estabelecimento com um ano de agenda anunciar centenas de linhas.
     */
    const { count } = await contar()
    expect(count).toBe(1)
  })

  it('a janela também limita quem voltou de férias com marca antiga', async () => {
    const { serviceId, professionalId, petId } = await cenario()

    const velho = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await criadoEm(velho.id, diasAtras(NOVOS_AGENDAMENTOS_JANELA_DIAS + 5))

    // Marca de um mês atrás: mais velha que a janela, e a janela é que manda.
    const { count } = await contar(diasAtras(30).toISOString())
    expect(count).toBe(0)
  })

  it('não conta o que a equipe marcou no balcão', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
    })

    const { count } = await contar()
    expect(count).toBe(0)
  })

  it('não conta o que espera aprovação — quem o conta é a fila da triagem', async () => {
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: tenant.tenantId },
      data: { onlineBookingRequiresApproval: true },
    })
    const { serviceId, professionalId, petId } = await cenario()
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
      source: 'PORTAL',
    })

    /*
     * As duas linhas aparecem juntas no mesmo painel. Contado nas duas, o mesmo
     * agendamento faria o sino somar 2 para uma coisa só.
     */
    const novos = await contar()
    expect(novos.count).toBe(0)

    const triagem = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/appointments/pending-count',
    })
    expect(triagem.json()).toMatchObject({ count: 1 })
  })

  it('não conta o que foi desmarcado — o clique não o encontraria na agenda', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await cancel(actor(), booking.id, { reason: 'O tutor desistiu' })

    const { count } = await contar()
    expect(count).toBe(0)
  })

  it('aponta para o dia do agendamento novo mais próximo', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: new Date(FUTURO.getTime() + 7 * 24 * 60 * 60 * 1000),
      items: [{ serviceId }],
      source: 'PORTAL',
    })
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
      source: 'PORTAL',
    })

    // O mais próximo, e não o criado primeiro: o sino aponta para o dia, não para a
    // ordem de chegada.
    const { count, nextDate } = await contar()
    expect(count).toBe(2)
    expect(nextDate).toBe(FUTURO_DIA)
  })

  it('o isolamento é por tenant', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: FUTURO,
      items: [{ serviceId }],
      source: 'PORTAL',
    })

    const vizinho = await givenTenant()
    const response = await callApi({
      ...asAdmin(vizinho),
      method: 'GET',
      url: '/v1/appointments/portal-new-count',
    })
    expect(response.json()).toMatchObject({ count: 0, nextDate: null })
  })
})
