import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/modules/scheduling/booking.js'
import { findAvailability } from '../src/modules/scheduling/availability.js'
import {
  closeHarness,
  givenPet,
  givenProfessional,
  givenService,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * MOD-AGENDA-04 e 11 — o algoritmo.
 *
 * Os testes trabalham em UTC e em instantes absolutos. Uma quinta-feira concreta:
 * 2026-09-03 é quinta (weekday 4), e a jornada padrão do harness vai das 08:00 às
 * 18:00 UTC todos os dias.
 */

const QUINTA_09H = new Date('2026-09-03T09:00:00.000Z')
const QUINTA_00H = new Date('2026-09-03T00:00:00.000Z')
const SEXTA_00H = new Date('2026-09-04T00:00:00.000Z')

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function actor() {
  return { tenantId: tenant.tenantId, actorUserId: tenant.userId }
}

describe('MOD-AGENDA-04 — criação do agendamento', () => {
  it('AC-01: calcula a duração pelo porte e pela pelagem, e congela o preço', async () => {
    // Banho e Tosa, 90 min no porte GRANDE; Thor tem pelagem DUPLA (fator 1,5).
    const serviceId = await givenService(tenant, {
      name: 'Banho e Tosa',
      category: 'GROOMING',
      durationMin: 90,
      priceCents: 15000,
    })
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant, { sizeKey: 'LARGE', coatKey: 'DOUBLE' })

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    // 90 × 1,5 = 135, já na grade.
    expect(booking.durationMin).toBe(135)
    expect(booking.endsAt.toISOString()).toBe('2026-09-03T11:15:00.000Z')
    expect(booking.totalCents).toBe(15000)

    const items = await ownerPrisma.appointmentItem.findMany({
      where: { appointmentId: booking.id },
    })
    expect(items).toHaveLength(1)
    // RN-04: o item carrega a própria fotografia de preço e duração.
    expect(Number(items[0]?.priceCents)).toBe(15000)
    expect(items[0]?.durationMin).toBe(135)
    expect(items[0]?.label).toBe('Banho e Tosa')
  })

  it('AC-01: nasce CONFIRMED e a trilha de estado registra a entrada', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant)

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.status).toBe('CONFIRMED')
    expect(row.source).toBe('STAFF')

    const log = await ownerPrisma.appointmentStatusLog.findMany({
      where: { appointmentId: booking.id },
    })
    expect(log).toHaveLength(1)
    expect(log[0]?.fromStatus).toBeNull()
    expect(log[0]?.toStatus).toBe('CONFIRMED')
  })

  it('RN-04: mudar o preço do catálogo não mexe no que já está marcado', async () => {
    const serviceId = await givenService(tenant, { priceCents: 7000 })
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant)

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    await ownerPrisma.servicePricing.updateMany({
      where: { serviceId },
      data: { priceCents: BigInt(9000) },
    })

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(Number(row.totalCents)).toBe(7000)
  })

  it('RN-03: porte sem preço recusa com 422, sem interpolar', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant, { sizeKey: 'GIANT' })

    // Apaga só o preço do porte gigante.
    const gigante = await ownerPrisma.size.findFirstOrThrow({
      where: { key: 'GIANT', tenantId: null },
    })
    await ownerPrisma.servicePricing.deleteMany({ where: { serviceId, sizeId: gigante.id } })

    await expect(
      createBooking(actor(), { petId, professionalId, startsAt: QUINTA_09H, items: [{ serviceId }] }),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_002' })
  })

  it('AC-03: profissional não habilitado no serviço é 409', async () => {
    const banho = await givenService(tenant, { name: 'Banho' })
    const vacina = await givenService(tenant, { name: 'Vacinação', category: 'VACCINE' })
    // Carlos só faz banho.
    const professionalId = await givenProfessional(tenant, {
      name: 'Carlos',
      serviceIds: [banho],
    })
    const { petId } = await givenPet(tenant)

    await expect(
      createBooking(actor(), {
        petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId: vacina }],
      }),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_005' })
  })

  it('AC-04: fora da jornada é 409 e vem com sugestões', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      // Só trabalha de manhã na quinta.
      windows: [{ weekday: 4, startsAtMin: 480, endsAtMin: 720 }],
    })
    const { petId } = await givenPet(tenant)

    const erro = await createBooking(actor(), {
      petId,
      professionalId,
      // 12:30, depois do fim da jornada.
      startsAt: new Date('2026-09-03T12:30:00.000Z'),
      items: [{ serviceId }],
    }).catch((error: unknown) => error)

    expect(erro).toMatchObject({ code: 'ERR_AGENDA_005' })
    const extra = (erro as { extra?: { suggestions?: unknown[] } }).extra
    expect(extra?.suggestions?.length).toBeGreaterThan(0)
  })

  it('AC-04: bloqueio na agenda impede o horário', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant)

    await withTenant(tenant.tenantId, (tx) =>
      tx.calendarBlock.create({
        data: {
          tenantId: tenant.tenantId,
          professionalId,
          startsAt: new Date('2026-09-03T08:00:00.000Z'),
          endsAt: new Date('2026-09-03T18:00:00.000Z'),
          reason: 'Folga',
        },
      }),
    )

    await expect(
      createBooking(actor(), { petId, professionalId, startsAt: QUINTA_09H, items: [{ serviceId }] }),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_005' })
  })

  it('AC-06: pet falecido não é agendável', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant, { status: 'DECEASED' })

    await expect(
      createBooking(actor(), { petId, professionalId, startsAt: QUINTA_09H, items: [{ serviceId }] }),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_010' })
  })
})

describe('RN-02 — capacidade é contagem, não existência', () => {
  it('o banhista com capacidade 3 aceita três pets sobrepostos', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      maxConcurrentPets: 3,
    })

    for (const nome of ['Thor', 'Mel', 'Bidu']) {
      const { petId } = await givenPet(tenant, { name: nome })
      const booking = await createBooking(actor(), {
        petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
      })
      expect(booking.id).toBeTruthy()
    }

    const marcados = await ownerPrisma.appointment.count({ where: { professionalId } })
    expect(marcados).toBe(3)
  })

  it('AC-02: o quarto pet estoura a capacidade e vem com sugestões', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      maxConcurrentPets: 3,
    })

    for (const nome of ['Thor', 'Mel', 'Bidu']) {
      const { petId } = await givenPet(tenant, { name: nome })
      await createBooking(actor(), {
        petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
      })
    }

    const { petId } = await givenPet(tenant, { name: 'Nina' })
    const erro = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    }).catch((error: unknown) => error)

    expect(erro).toMatchObject({ code: 'ERR_AGENDA_004' })
    const extra = (erro as { extra?: { suggestions?: { startsAt: string }[] } }).extra
    expect(extra?.suggestions?.length).toBeGreaterThan(0)
    // A primeira sugestão é depois do bloco lotado.
    expect(new Date(extra!.suggestions![0]!.startsAt).getTime()).toBeGreaterThanOrEqual(
      new Date('2026-09-03T10:00:00.000Z').getTime(),
    )
  })

  it('capacidade 1: atendimentos sequenciais não conflitam', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })

    const primeiro = await givenPet(tenant, { name: 'Thor' })
    const segundo = await givenPet(tenant, { name: 'Mel' })

    await createBooking(actor(), {
      petId: primeiro.petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    // 10:00 começa exatamente quando o outro termina — janelas semiabertas.
    const encostado = await createBooking(actor(), {
      petId: segundo.petId,
      professionalId,
      startsAt: new Date('2026-09-03T10:00:00.000Z'),
      items: [{ serviceId }],
    })
    expect(encostado.id).toBeTruthy()
  })
})

describe('MOD-AGENDA-11 — disponibilidade', () => {
  it('AC-01: oferece horários na grade de 15 min dentro da jornada', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })

    const { slots } = await withTenant(tenant.tenantId, (tx) =>
      findAvailability(tx, {
        professionalIds: [professionalId],
        durationMin: 60,
        from: QUINTA_00H,
        to: SEXTA_00H,
      }),
    )

    expect(slots.length).toBeGreaterThan(0)
    expect(slots[0]?.startsAt.toISOString()).toBe('2026-09-03T08:00:00.000Z')
    // Jornada 08:00–18:00 com serviço de 60 min: o último início possível é 17:00.
    expect(slots[slots.length - 1]?.startsAt.toISOString()).toBe('2026-09-03T17:00:00.000Z')
    // 10h de jornada, passo de 15 min, menos a última hora que não cabe: 37 inícios.
    expect(slots).toHaveLength(37)
  })

  it('o almoço parte o dia: nenhum horário cai no vão entre as faixas', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      windows: [
        { weekday: 4, startsAtMin: 480, endsAtMin: 720 },
        { weekday: 4, startsAtMin: 780, endsAtMin: 1080 },
      ],
    })

    const { slots } = await withTenant(tenant.tenantId, (tx) =>
      findAvailability(tx, {
        professionalIds: [professionalId],
        durationMin: 60,
        from: QUINTA_00H,
        to: SEXTA_00H,
      }),
    )

    const horas = slots.map((slot) => slot.startsAt.toISOString().slice(11, 16))
    expect(horas).toContain('11:00')
    // 11:15 terminaria 12:15, dentro do almoço.
    expect(horas).not.toContain('11:15')
    expect(horas).not.toContain('12:00')
    expect(horas).toContain('13:00')
  })

  it('AC-02: semana lotada devolve lista vazia mais `nextAvailable`', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      windows: [{ weekday: 4, startsAtMin: 480, endsAtMin: 1080 }],
    })

    // Bloqueia a quinta inteira; a próxima quinta continua livre.
    await withTenant(tenant.tenantId, (tx) =>
      tx.calendarBlock.create({
        data: {
          tenantId: tenant.tenantId,
          professionalId,
          startsAt: QUINTA_00H,
          endsAt: SEXTA_00H,
          reason: 'Folga',
        },
      }),
    )

    const result = await withTenant(tenant.tenantId, (tx) =>
      findAvailability(tx, {
        professionalIds: [professionalId],
        durationMin: 60,
        from: QUINTA_00H,
        to: SEXTA_00H,
      }),
    )

    expect(result.slots).toHaveLength(0)
    expect(result.nextAvailable).not.toBeNull()
    // A quinta seguinte, 10/09.
    expect(result.nextAvailable?.toISOString()).toBe('2026-09-10T08:00:00.000Z')
  })

  it('o feriado do tenant tira o dia de todo mundo', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const ana = await givenProfessional(tenant, { name: 'Ana', serviceIds: [serviceId] })
    const carlos = await givenProfessional(tenant, { name: 'Carlos', serviceIds: [serviceId] })

    await withTenant(tenant.tenantId, (tx) =>
      tx.calendarBlock.create({
        data: {
          tenantId: tenant.tenantId,
          professionalId: null,
          startsAt: QUINTA_00H,
          endsAt: SEXTA_00H,
          reason: 'Feriado',
        },
      }),
    )

    const { slots } = await withTenant(tenant.tenantId, (tx) =>
      findAvailability(tx, {
        professionalIds: [ana, carlos],
        durationMin: 60,
        from: QUINTA_00H,
        to: SEXTA_00H,
      }),
    )

    expect(slots).toHaveLength(0)
  })

  it('a ocupação some da oferta na medida da capacidade', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      maxConcurrentPets: 1,
      windows: [{ weekday: 4, startsAtMin: 480, endsAtMin: 600 }],
    })
    const { petId } = await givenPet(tenant)

    const antes = await withTenant(tenant.tenantId, (tx) =>
      findAvailability(tx, {
        professionalIds: [professionalId],
        durationMin: 60,
        from: QUINTA_00H,
        to: SEXTA_00H,
      }),
    )
    // Jornada 08:00–10:00, serviço de 60 min: 08:00, 08:15 … 09:00 = 5 inícios.
    expect(antes.slots).toHaveLength(5)

    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: new Date('2026-09-03T08:00:00.000Z'),
      items: [{ serviceId }],
    })

    const depois = await withTenant(tenant.tenantId, (tx) =>
      findAvailability(tx, {
        professionalIds: [professionalId],
        durationMin: 60,
        from: QUINTA_00H,
        to: SEXTA_00H,
      }),
    )
    // Só 09:00 sobra: qualquer início antes disso cruza o atendimento das 08:00.
    expect(depois.slots).toHaveLength(1)
    expect(depois.slots[0]?.startsAt.toISOString()).toBe('2026-09-03T09:00:00.000Z')
  })
})

describe('AC-05 e RN-13 — a corrida pelo último lugar', () => {
  it('dois atendentes salvando o mesmo último lugar: um passa, o outro recebe 409', async () => {
    const serviceId = await givenService(tenant, { durationMin: 60 })
    const professionalId = await givenProfessional(tenant, {
      serviceIds: [serviceId],
      maxConcurrentPets: 1,
    })
    const thor = await givenPet(tenant, { name: 'Thor' })
    const mel = await givenPet(tenant, { name: 'Mel' })

    // Disparados juntos, sem await entre eles: é a corrida do AC-05.
    const resultados = await Promise.allSettled([
      createBooking(actor(), {
        petId: thor.petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
      }),
      createBooking(actor(), {
        petId: mel.petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
      }),
    ])

    const aceitos = resultados.filter((r) => r.status === 'fulfilled')
    const recusados = resultados.filter((r) => r.status === 'rejected')

    expect(aceitos).toHaveLength(1)
    expect(recusados).toHaveLength(1)

    // O recusado leva 409 de capacidade, não 500: o pedido não estava errado, só
    // chegou em segundo lugar.
    const erro = (recusados[0] as PromiseRejectedResult).reason as { code?: string; status?: number }
    expect(erro.code).toBe('ERR_AGENDA_004')
    expect(erro.status).toBe(409)

    // E o banco tem exatamente um. Sem SERIALIZABLE, os dois entrariam: ambos
    // contariam zero antes de qualquer inserção.
    const marcados = await ownerPrisma.appointment.count({ where: { professionalId } })
    expect(marcados).toBe(1)
  })

  it('a trilha de estado recusa UPDATE e DELETE', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant)

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    const log = await ownerPrisma.appointmentStatusLog.findFirstOrThrow({
      where: { appointmentId: booking.id },
    })

    // Nem o dono da tabela reescreve a trilha: o trigger vale para todos.
    await expect(
      ownerPrisma.appointmentStatusLog.update({
        where: { id: log.id },
        data: { toStatus: 'CANCELLED' },
      }),
    ).rejects.toThrow(/append-only/)

    await expect(
      ownerPrisma.appointmentStatusLog.delete({ where: { id: log.id } }),
    ).rejects.toThrow(/append-only/)
  })

  it('não enxerga agendamento de outro tenant', async () => {
    const serviceId = await givenService(tenant)
    const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
    const { petId } = await givenPet(tenant)

    await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })

    const outro = await givenTenant('Outro Petshop')
    const vistos = await withTenant(outro.tenantId, (tx) => tx.appointment.count())
    expect(vistos).toBe(0)
  })
})
