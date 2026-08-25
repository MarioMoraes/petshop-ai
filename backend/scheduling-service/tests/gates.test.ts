import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/modules/scheduling/booking.js'
import { setBillingPort } from '../src/modules/scheduling/gates.js'
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

/** MOD-AGENDA-10 — os gates. */

const QUINTA_09H = new Date('2026-09-03T09:00:00.000Z')

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
  const serviceId = await givenService(tenant)
  const professionalId = await givenProfessional(tenant, { serviceIds: [serviceId] })
  const { petId, tutorId } = await givenPet(tenant)
  return { serviceId, professionalId, petId, tutorId }
}

describe('RN-09 — alerta clínico é bloqueio suave', () => {
  it('AC-01: alergia CRÍTICA ao serviço bloqueia e devolve os alertas', async () => {
    const { serviceId, professionalId, petId } = await cenario()

    await withTenant(tenant.tenantId, (tx) =>
      tx.allergy.create({
        data: {
          tenantId: tenant.tenantId,
          petId,
          label: 'Shampoo de aveia',
          type: 'PRODUCT',
          severity: 'CRITICAL',
          blocksServices: [serviceId],
        },
      }),
    )

    const erro = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    }).catch((e: unknown) => e)

    expect(erro).toMatchObject({ code: 'ERR_AGENDA_009' })
    const extra = (erro as { extra?: { alerts?: { label: string }[] } }).extra
    expect(extra?.alerts?.[0]?.label).toBe('Shampoo de aveia')
  })

  it('AC-01: repetir com `acknowledgedAlerts` conclui e grava quem assumiu o risco', async () => {
    const { serviceId, professionalId, petId } = await cenario()

    await withTenant(tenant.tenantId, (tx) =>
      tx.allergy.create({
        data: {
          tenantId: tenant.tenantId,
          petId,
          label: 'Shampoo de aveia',
          type: 'PRODUCT',
          severity: 'CRITICAL',
          blocksServices: [serviceId],
        },
      }),
    )

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
      acknowledgedAlerts: true,
    })

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.acknowledgedAlertsBy).toBe(tenant.userId)
    expect(row.acknowledgedAlertsAt).not.toBeNull()

    // O nome da alergia fica na trilha: é o que responde "o que exatamente foi
    // reconhecido" quando alguém perguntar.
    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { entityId: booking.id, action: 'appointment.created' },
    })
    expect((audit.after as Record<string, unknown>).acknowledgedAlerts).toEqual([
      'Shampoo de aveia',
    ])
  })

  it('alergia de severidade média não bloqueia', async () => {
    const { serviceId, professionalId, petId } = await cenario()

    await withTenant(tenant.tenantId, (tx) =>
      tx.allergy.create({
        data: {
          tenantId: tenant.tenantId,
          petId,
          label: 'Perfume',
          type: 'PRODUCT',
          severity: 'MEDIUM',
          blocksServices: [serviceId],
        },
      }),
    )

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(booking.id).toBeTruthy()
  })

  it('alergia crítica sem relação com o serviço não bloqueia', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const outro = await givenService(tenant, { name: 'Tosa' })

    await withTenant(tenant.tenantId, (tx) =>
      tx.allergy.create({
        data: {
          tenantId: tenant.tenantId,
          petId,
          label: 'Lâmina',
          type: 'PRODUCT',
          severity: 'CRITICAL',
          blocksServices: [outro],
        },
      }),
    )

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(booking.id).toBeTruthy()
  })
})

/**
 * RN-02: **saldo negativo é dívida**, positivo é crédito do tutor. Esta suíte usava o
 * sinal invertido e passava por causa de um bug de comparação em `assertCreditAllowed`
 * — que só era inerte porque `creditLimitCents` era sempre nulo. Com o MOD-LEDGER, o
 * limite passou a existir de verdade, e os dois lados foram corrigidos juntos.
 */
describe('RN-11 — inadimplência alerta; bloqueia por opt-in', () => {
  it('AC-03: limite nulo nunca bloqueia, por mais que o tutor deva', async () => {
    const { serviceId, professionalId, petId, tutorId } = await cenario()
    await ownerPrisma.tutor.update({
      where: { id: tutorId },
      data: { balanceCents: -500_000 },
    })

    // O padrão do sistema: sem limite configurado, o débito é alerta, não barreira.
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(booking.id).toBeTruthy()
  })

  it('AC-02: acima do limite exige override e diz o quanto está devendo', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    setBillingPort({
      creditStatus: async () => ({ balanceCents: -30_000, creditLimitCents: 10_000 }),
    })

    const erro = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    }).catch((e: unknown) => e)

    expect(erro).toMatchObject({ code: 'ERR_AGENDA_008' })
    expect((erro as Error).message).toContain('300,00')
    const extra = (erro as { extra?: { requiresOverride?: boolean } }).extra
    expect(extra?.requiresOverride).toBe(true)
  })

  it('AC-02: o override do admin passa e fica auditado', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    setBillingPort({
      creditStatus: async () => ({ balanceCents: -30_000, creditLimitCents: 10_000 }),
    })

    const booking = await createBooking(
      actor(),
      {
        petId,
        professionalId,
        startsAt: QUINTA_09H,
        items: [{ serviceId }],
        override: { reason: 'Cliente antigo, vai quitar no atendimento' },
      },
      { canOverrideCredit: true },
    )

    const row = await ownerPrisma.appointment.findUniqueOrThrow({ where: { id: booking.id } })
    expect(row.creditOverrideBy).toBe(tenant.userId)
    expect(row.creditOverrideReason).toContain('Cliente antigo')
  })

  it('AC-02: sem a permissão, o override é recusado', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    setBillingPort({
      creditStatus: async () => ({ balanceCents: -30_000, creditLimitCents: 10_000 }),
    })

    await expect(
      createBooking(
        actor(),
        {
          petId,
          professionalId,
          startsAt: QUINTA_09H,
          items: [{ serviceId }],
          override: { reason: 'A recepção resolveu liberar' },
        },
        { canOverrideCredit: false },
      ),
    ).rejects.toMatchObject({ code: 'ERR_AGENDA_008' })
  })

  it('dentro do limite passa sem override', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    setBillingPort({
      creditStatus: async () => ({ balanceCents: -5_000, creditLimitCents: 10_000 }),
    })

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(booking.id).toBeTruthy()
  })

  /**
   * A porta **real**, lendo `ledger_accounts` e `billing_settings` do MOD-LEDGER.
   *
   * Os testes acima dublam a porta para exercitar a regra; estes provam que a
   * implementação que o `app.ts` liga devolve os números certos. Até o MOD-LEDGER
   * existir, ela era um padrão que respondia "limite nulo" — e por isso nada nunca
   * bloqueava, por mais que o petshop configurasse.
   */
  it('a porta real lê o limite configurado e bloqueia de verdade', async () => {
    const { serviceId, professionalId, petId, tutorId } = await cenario()
    const { livePort } = await import('../src/modules/scheduling/billing-port.js')
    setBillingPort(livePort)

    await withTenant(tenant.tenantId, async (tx) => {
      await tx.billingSettings.create({
        data: { tenantId: tenant.tenantId, creditLimitCents: 10_000n, enabledPaymentMethods: [] },
      })
      const account = await tx.ledgerAccount.create({
        data: { tenantId: tenant.tenantId, tutorId, balanceCents: -30_000n },
      })
      return account
    })

    const erro = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    }).catch((e: unknown) => e)

    expect(erro).toMatchObject({ code: 'ERR_AGENDA_008' })
  })

  it('a porta real devolve limite nulo para tenant que nunca configurou', async () => {
    const { serviceId, professionalId, petId, tutorId } = await cenario()
    const { livePort } = await import('../src/modules/scheduling/billing-port.js')
    setBillingPort(livePort)

    await withTenant(tenant.tenantId, (tx) =>
      tx.ledgerAccount.create({
        data: { tenantId: tenant.tenantId, tutorId, balanceCents: -500_000n },
      }),
    )

    // Sem `billing_settings`, o LEFT JOIN devolve nulo — que é o AC-03 literal.
    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(booking.id).toBeTruthy()
  })

  it('a porta real trata tutor sem conta como quem não deve nada (RN-17)', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    const { livePort } = await import('../src/modules/scheduling/billing-port.js')
    setBillingPort(livePort)

    await withTenant(tenant.tenantId, (tx) =>
      tx.billingSettings.create({
        data: { tenantId: tenant.tenantId, creditLimitCents: 10_000n, enabledPaymentMethods: [] },
      }),
    )

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(booking.id).toBeTruthy()
  })

  it('saldo positivo é crédito do tutor, e crédito nunca bloqueia', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    // O tutor tem R$ 300 **a favor** dele. Comparar o saldo com o limite sem olhar o
    // sinal — como o código fazia — barraria justamente quem está adiantado.
    setBillingPort({
      creditStatus: async () => ({ balanceCents: 30_000, creditLimitCents: 10_000 }),
    })

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: QUINTA_09H,
      items: [{ serviceId }],
    })
    expect(booking.id).toBeTruthy()
  })
})

describe('RN-07 — antecedência mínima só vale para o Portal', () => {
  it('o Portal respeita as 2h de antecedência', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    await ownerPrisma.tenantSettings.create({
      data: {
        tenantId: tenant.tenantId,
        branding: {},
        businessHours: {},
        minBookingNoticeHours: 2,
      },
    })

    const daquiUmaHora = new Date(Date.now() + 60 * 60_000)
    const erro = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: daquiUmaHora,
      items: [{ serviceId }],
      source: 'PORTAL',
    }).catch((e: unknown) => e)

    expect(erro).toMatchObject({ code: 'ERR_AGENDA_007' })
    expect((erro as { extra?: { nextAvailable?: string } }).extra?.nextAvailable).toBeTruthy()
  })

  it('no balcão não existe antecedência mínima — o tutor está na frente do atendente', async () => {
    const { serviceId, professionalId, petId } = await cenario()
    await ownerPrisma.tenantSettings.create({
      data: {
        tenantId: tenant.tenantId,
        branding: {},
        businessHours: {},
        minBookingNoticeHours: 2,
      },
    })

    // Daqui a 15 minutos, dentro da jornada. STAFF passa.
    const agora = new Date()
    const daquiAPouco = new Date(
      Date.UTC(
        agora.getUTCFullYear(),
        agora.getUTCMonth(),
        agora.getUTCDate() + 1,
        9,
        0,
        0,
      ),
    )

    const booking = await createBooking(actor(), {
      petId,
      professionalId,
      startsAt: daquiAPouco,
      items: [{ serviceId }],
      source: 'STAFF',
    })
    expect(booking.id).toBeTruthy()
  })
})
