import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../../src/modules/scheduling/booking.js'
import { getNoShows } from '../../src/modules/scheduling/movement.js'
import { cancel, markNoShow } from '../../src/modules/scheduling/transitions.js'
import {
  asAdmin,
  asReceptionist,
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
 * As faltas do período, no Início.
 *
 * Conta pela data do atendimento — a falta marcada hoje para um horário de ontem é de
 * ontem — e só o que é falta: cancelamento não esvazia horário do mesmo jeito, porque
 * avisou antes.
 */

const DAY_MS = 86_400_000

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function actor() {
  return { tenantId: tenant.tenantId, actorUserId: tenant.userId }
}

/** Uma quinta-feira distante às 9h UTC — a jornada do fixture cobre e ninguém a alcança. */
function quintaDistante(): Date {
  const dia = new Date()
  dia.setUTCHours(9, 0, 0, 0)
  dia.setUTCDate(dia.getUTCDate() + 35)
  dia.setUTCDate(dia.getUTCDate() + ((4 - dia.getUTCDay() + 7) % 7))
  return dia
}

/**
 * Marca, e então leva o horário para `daysAgo` dias atrás.
 *
 * A agenda não aceita marcar no passado, e é justamente o passado que a consulta lê: o
 * horário é movido direto no banco depois da transição, que é o que o tempo faria.
 */
async function agendamento(priceCents: number, daysAgo: number, desfecho: 'falta' | 'cancelado') {
  // Nome próprio por agendamento: o catálogo não aceita dois "Banho" no mesmo tenant.
  const sufixo = `${priceCents}-${daysAgo}`
  const serviceId = await givenService(tenant, { name: `Banho ${sufixo}`, priceCents })
  const professionalId = await givenProfessional(tenant, {
    name: `Ana ${sufixo}`,
    serviceIds: [serviceId],
  })
  const { petId } = await givenPet(tenant, { name: `Thor ${sufixo}` })
  const booking = await createBooking(actor(), {
    petId,
    professionalId,
    startsAt: quintaDistante(),
    items: [{ serviceId }],
  })

  if (desfecho === 'falta') await markNoShow(actor(), booking.id)
  else await cancel(actor(), booking.id, {})

  const startsAt = new Date(Date.now() - daysAgo * DAY_MS)
  await ownerPrisma.appointment.update({
    where: { id: booking.id },
    data: { startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) },
  })
}

describe('faltas', () => {
  it('soma as faltas da janela pela data do atendimento, sem o cancelado', async () => {
    await agendamento(8_000, 3, 'falta')
    await agendamento(12_000, 10, 'falta')
    await agendamento(50_000, 40, 'falta')
    await agendamento(9_000, 5, 'cancelado')

    const result = await getNoShows(tenant.tenantId, 30)

    expect(result.count).toBe(2)
    expect(result.totalCents).toBe(20_000)
  })

  it('responde pela rota a quem configura o estabelecimento, e recusa a recepção', async () => {
    await agendamento(8_000, 1, 'falta')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/agenda/reports/no-shows?days=7',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ days: 7, count: 1, totalCents: 8_000 })

    const negado = await callApi({
      ...(await asReceptionist(tenant)),
      method: 'GET',
      url: '/v1/agenda/reports/no-shows',
    })
    expect(negado.statusCode).toBe(403)
  })
})
