import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  sizeIds,
  type TenantFixture,
} from './harness.js'

/** MOD-AGENDA-01 — catálogo de serviços. */

let tenant: TenantFixture
let sizes: Awaited<ReturnType<typeof sizeIds>>

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  sizes = await sizeIds()
})

afterAll(closeHarness)

function banhoPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Banho',
    category: 'BATH',
    baseDurationMin: 60,
    pricing: [
      { sizeId: sizes.SMALL, priceCents: 5000, durationMin: 45 },
      { sizeId: sizes.MEDIUM, priceCents: 7000, durationMin: 60 },
      { sizeId: sizes.LARGE, priceCents: 9000, durationMin: 90 },
      { sizeId: sizes.GIANT, priceCents: 12000, durationMin: 120 },
    ],
    ...overrides,
  }
}

describe('MOD-AGENDA-01 — catálogo de serviços', () => {
  it('AC-01: cria o serviço com as quatro linhas de preço e ele aparece no seletor', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/services',
      payload: banhoPayload(),
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.name).toBe('Banho')
    expect(body.pricing).toHaveLength(4)
    expect(body.active).toBe(true)

    const listagem = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/services' })
    expect(listagem.json()).toHaveLength(1)
  })

  it('AC-01: duração é por porte, não multiplicador — cada linha guarda a sua', async () => {
    const criado = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/services',
        payload: banhoPayload(),
      })
    ).json()

    const porPorte = new Map<string, number>(
      criado.pricing.map((item: { sizeId: string; durationMin: number }) => [
        item.sizeId,
        item.durationMin,
      ]),
    )

    // 90 min no porte grande não é 60 × nenhum fator redondo: é o número que o
    // petshop digitou, e é exatamente isso que a decisão do §11 Q1 preserva.
    expect(porPorte.get(sizes.SMALL)).toBe(45)
    expect(porPorte.get(sizes.LARGE)).toBe(90)
    expect(porPorte.get(sizes.GIANT)).toBe(120)
  })

  it('AC-02: porte sem preço devolve 422 e não interpola', async () => {
    const criado = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/services',
        payload: banhoPayload({
          pricing: [{ sizeId: sizes.SMALL, priceCents: 5000, durationMin: 45 }],
        }),
      })
    ).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/services/${criado.id}/pricing?sizeId=${sizes.GIANT}`,
    })

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.code).toBe('ERR_AGENDA_002')
    expect(body.detail).toContain('Gigante')
  })

  it('AC-02: o porte com preço resolve com o valor e a duração da tabela', async () => {
    const criado = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/services',
        payload: banhoPayload(),
      })
    ).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/services/${criado.id}/pricing?sizeId=${sizes.LARGE}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ priceCents: 9000, durationMin: 90 })
  })

  it('AC-03: serviço com agendamento futuro não é excluído, mas é desativado', async () => {
    const criado = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/services',
        payload: banhoPayload(),
      })
    ).json()

    const { setAppointmentsPort } = await import('../src/modules/catalog/port.js')
    setAppointmentsPort({
      countByService: async () => 40,
      listByProfessional: async () => [],
      listInWindow: async () => [],
      cancelBatch: async () => undefined,
    })

    const exclusao = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/services/${criado.id}`,
    })

    expect(exclusao.statusCode).toBe(409)
    const body = exclusao.json()
    expect(body.code).toBe('ERR_AGENDA_011')
    expect(body.futureAppointments).toBe(40)

    const desativacao = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/services/${criado.id}`,
      payload: { active: false },
    })

    expect(desativacao.statusCode).toBe(200)
    expect(desativacao.json().active).toBe(false)

    // Sumiu do seletor, mas continua existindo para o histórico.
    const seletor = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/services' })
    expect(seletor.json()).toHaveLength(0)

    const completa = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/services?includeInactive=true',
    })
    expect(completa.json()).toHaveLength(1)
  })

  it('AC-03: sem agendamento futuro, a exclusão passa e é soft delete', async () => {
    const criado = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/services',
        payload: banhoPayload(),
      })
    ).json()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/services/${criado.id}`,
    })

    expect(response.statusCode).toBe(204)

    // A linha continua no banco: o agendamento antigo precisa saber o nome do que
    // foi vendido.
    const linha = await ownerPrisma.service.findUniqueOrThrow({ where: { id: criado.id } })
    expect(linha.deletedAt).not.toBeNull()
  })

  it('AC-04: mudar o preço não mexe em quem já estava marcado', async () => {
    const criado = (
      await callApi({
        ...asAdmin(tenant),
        method: 'POST',
        url: '/v1/services',
        payload: banhoPayload(),
      })
    ).json()

    await callApi({
      ...asAdmin(tenant),
      method: 'PUT',
      url: `/v1/services/${criado.id}/pricing`,
      payload: {
        pricing: [{ sizeId: sizes.MEDIUM, priceCents: 8000, durationMin: 60 }],
      },
    })

    const atual = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/services/${criado.id}/pricing?sizeId=${sizes.MEDIUM}`,
    })

    // O catálogo passa a valer 80,00 para quem agendar daqui em diante. O
    // congelamento do agendamento já criado (RN-04) é `appointment_items`, da fatia
    // 2 — aqui se garante o outro lado: a tabela mudou de verdade.
    expect(atual.json().priceCents).toBe(8000)

    const antigos = await ownerPrisma.servicePricing.findMany({
      where: { serviceId: criado.id },
    })
    expect(antigos).toHaveLength(1)
  })

  it('recusa duas linhas de preço para o mesmo porte', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/services',
      payload: banhoPayload({
        pricing: [
          { sizeId: sizes.SMALL, priceCents: 5000, durationMin: 45 },
          { sizeId: sizes.SMALL, priceCents: 6000, durationMin: 60 },
        ],
      }),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_AGENDA_002')
  })

  it('recusa duração fora da grade de 15 minutos', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/services',
      payload: banhoPayload({
        pricing: [{ sizeId: sizes.SMALL, priceCents: 5000, durationMin: 50 }],
      }),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toContain('múltipla de 15')
  })

  it('a recepção lê o catálogo, mas não o edita (§9)', async () => {
    const leitura = await callApi({
      ...asReceptionist(tenant),
      method: 'GET',
      url: '/v1/services',
    })
    expect(leitura.statusCode).toBe(200)

    const escrita = await callApi({
      ...asReceptionist(tenant),
      method: 'POST',
      url: '/v1/services',
      payload: banhoPayload(),
    })
    expect(escrita.statusCode).toBe(403)
    expect(escrita.json().code).toBe('ERR_AGENDA_003')
  })

  it('não vaza o catálogo de outro tenant', async () => {
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/services',
      payload: banhoPayload(),
    })

    const outro = await givenTenant('Outro Petshop')
    const response = await callApi({ ...asAdmin(outro), method: 'GET', url: '/v1/services' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveLength(0)
  })
})
