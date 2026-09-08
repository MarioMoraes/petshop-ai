import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { dispatchTenant } from '../../src/modules/messaging/dispatch.js'
import { enqueueMessage } from '../../src/modules/messaging/messages.js'
import {
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  resetDatabase,
  resetPorts,
  type FakePort,
  type TenantFixture,
} from './fixtures.js'

/**
 * O teto semanal de marketing por tutor, e as revalidações que a fatia 3 do MOD-CRM
 * acrescentou ao despacho.
 */

let fixture: TenantFixture
let email: FakePort

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  fixture = await givenTenant()
  email = installFakeEmailPort()
})

afterAll(closeHarness)

function actor(tenantId: string) {
  return { tenantId, actorUserId: undefined }
}

async function enqueueMarketing(
  tenantId: string,
  tutorId: string,
  dedupeKey: string,
  extra: Record<string, unknown> = {},
) {
  return enqueueMessage(actor(tenantId), {
    recipientKind: 'TUTOR',
    tutorId,
    templateKey: 'campaign_broadcast',
    channel: 'EMAIL',
    dedupeKey,
    variables: {},
    urgent: false,
    // `extra` é `Record<string, unknown>` de propósito — cada teste sobrescreve um campo
    // diferente. É o único ponto do arquivo em que a conversão se justifica.
    ...extra,
  } as Parameters<typeof enqueueMessage>[1])
}

describe('teto semanal de marketing', () => {
  it('deixa passar a primeira e bloqueia a segunda da semana', async () => {
    await enableMessaging(fixture, { marketingWeeklyCap: 1 })
    const tutorId = await givenTutor(fixture, { marketing: { email: true } })

    // O estado da fila depende do dia e da hora — marketing não sai domingo, e a janela
    // de silêncio agenda o que cai fora dela. O que este teste afirma é o **bloqueio**,
    // que não depende de nenhum dos dois.
    const first = await enqueueMarketing(fixture.tenantId, tutorId, 'campanha-1')
    expect(first.blockReason).toBeNull()

    const second = await enqueueMarketing(fixture.tenantId, tutorId, 'campanha-2')
    expect(second.status).toBe('BLOCKED')
    expect(second.blockReason).toBe('WEEKLY_CAP')
  })

  it('não represa transacional nem operacional', async () => {
    await enableMessaging(fixture, { marketingWeeklyCap: 1 })
    const tutorId = await givenTutor(fixture, { marketing: { email: true } })

    await enqueueMarketing(fixture.tenantId, tutorId, 'campanha-1')

    // O lembrete é execução de contrato: represá-lo por causa de uma oferta seria
    // inverter exatamente a prioridade que o módulo defende.
    const reminder = await enqueueMessage(actor(fixture.tenantId), {
      recipientKind: 'TUTOR',
      tutorId,
      templateKey: 'appointment_reminder',
      channel: 'EMAIL',
      dedupeKey: 'lembrete-1',
      variables: {},
      urgent: false,
    })

    expect(reminder.blockReason).toBeNull()
  })

  it('teto zero desliga a regra', async () => {
    await enableMessaging(fixture, { marketingWeeklyCap: 0 })
    const tutorId = await givenTutor(fixture, { marketing: { email: true } })

    await enqueueMarketing(fixture.tenantId, tutorId, 'campanha-1')
    const second = await enqueueMarketing(fixture.tenantId, tutorId, 'campanha-2')

    // Pode voltar `MERGED` — a RN-08 absorve a irmã de cinco minutos —, e é justamente
    // por isso que a asserção é sobre o bloqueio: `MERGED` significa que ela **vai**
    // sair, dentro do corpo da outra.
    expect(second.blockReason).toBeNull()
    expect(second.status).not.toBe('BLOCKED')
  })

  it('conta só o que chegou ao tutor: bloqueada não gasta cota', async () => {
    await enableMessaging(fixture, { marketingWeeklyCap: 1 })
    // Sem consentimento de marketing: a primeira nasce bloqueada.
    const tutorId = await givenTutor(fixture, { marketing: { email: false } })

    const first = await enqueueMarketing(fixture.tenantId, tutorId, 'campanha-1')
    expect(first.blockReason).toBe('NO_CONSENT')

    // O tutor aceita depois. A bloqueada não pode ter gasto a cota da semana.
    await withTenant(fixture.tenantId, (tx) =>
      tx.tutorConsent.create({
        data: {
          tenantId: fixture.tenantId,
          tutorId,
          channel: 'EMAIL',
          granted: true,
          purpose: 'MARKETING',
          version: '1.0',
          source: 'STAFF_FORM',
        },
      }),
    )

    const second = await enqueueMarketing(fixture.tenantId, tutorId, 'campanha-2')
    expect(second.blockReason).toBeNull()
  })

  it('a cota é por tutor, não do estabelecimento', async () => {
    await enableMessaging(fixture, { marketingWeeklyCap: 1 })
    const ana = await givenTutor(fixture, { marketing: { email: true } })
    const bruno = await givenTutor(fixture, { marketing: { email: true } })

    await enqueueMarketing(fixture.tenantId, ana, 'campanha-ana')
    const outro = await enqueueMarketing(fixture.tenantId, bruno, 'campanha-bruno')

    expect(outro.blockReason).toBeNull()
  })
})

describe('revalidação no despacho (RN-03)', () => {
  it('bloqueia a mensagem cujo pet morreu entre a fila e o envio', async () => {
    // `marketingWeekdaysOnly: false` porque a felicitação é MARKETING: num domingo ela
    // nasceria agendada para segunda e o worker não a pegaria nesta passada.
    await enableMessaging(fixture, { marketingWeekdaysOnly: false })
    const tutorId = await givenTutor(fixture, { marketing: { email: true } })

    const petId = await withTenant(fixture.tenantId, async (tx) => {
      const [species, size] = await Promise.all([
        tx.species.findFirstOrThrow({ where: { key: 'DOG' } }),
        tx.size.findFirstOrThrow({ where: { key: 'LARGE' } }),
      ])
      const pet = await tx.pet.create({
        data: {
          tenantId: fixture.tenantId,
          name: 'Rex',
          speciesId: species.id,
          sizeId: size.id,
          status: 'ACTIVE',
        },
        select: { id: true },
      })
      return pet.id
    })

    const message = await enqueueMessage(actor(fixture.tenantId), {
      recipientKind: 'TUTOR',
      tutorId,
      petId,
      templateKey: 'birthday_pet',
      channel: 'EMAIL',
      dedupeKey: 'aniversario-1',
      variables: { 'pet.nome': 'Rex' },
      urgent: false,
    })
    expect(message.blockReason).toBeNull()

    // O tutor comunica o óbito no balcão, horas depois.
    await withTenant(fixture.tenantId, (tx) =>
      tx.pet.update({ where: { id: petId }, data: { status: 'DECEASED' } }),
    )

    const summary = await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(summary.blocked).toBe(1)
    expect(email.sent).toHaveLength(0)
    const stored = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: message.id } }),
    )
    expect(stored.status).toBe('BLOCKED')
    expect(stored.blockReason).toBe('PET_DECEASED')
  })

  it('cancela a cobrança de quem pagou entre a fila e o envio (AC-03 de MOD-CRM-08)', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    await withTenant(fixture.tenantId, (tx) =>
      tx.tutor.update({ where: { id: tutorId }, data: { balanceCents: -8000 } }),
    )

    const message = await enqueueMessage(actor(fixture.tenantId), {
      recipientKind: 'TUTOR',
      tutorId,
      templateKey: 'dunning_soft',
      channel: 'EMAIL',
      dedupeKey: 'cobranca-1',
      originType: 'LEDGER_ENTRY',
      originId: '00000000-0000-4000-8000-000000000001',
      variables: { 'financeiro.valor_devido': 'R$ 80,00', 'financeiro.dias_atraso': '3' },
      urgent: false,
    })

    // Pagou no balcão às 07h40, antes de a mensagem das 08h sair.
    await withTenant(fixture.tenantId, (tx) =>
      tx.tutor.update({ where: { id: tutorId }, data: { balanceCents: 0 } }),
    )

    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(email.sent).toHaveLength(0)
    const stored = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id: message.id } }),
    )
    // `CANCELLED`, não `BLOCKED`: não houve impedimento — o motivo do envio deixou de
    // existir.
    expect(stored.status).toBe('CANCELLED')
  })

  it('mantém a cobrança de quem continua devendo', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    await withTenant(fixture.tenantId, (tx) =>
      tx.tutor.update({ where: { id: tutorId }, data: { balanceCents: -8000 } }),
    )

    await enqueueMessage(actor(fixture.tenantId), {
      recipientKind: 'TUTOR',
      tutorId,
      templateKey: 'dunning_soft',
      channel: 'EMAIL',
      dedupeKey: 'cobranca-1',
      originType: 'LEDGER_ENTRY',
      originId: '00000000-0000-4000-8000-000000000001',
      variables: { 'financeiro.valor_devido': 'R$ 80,00', 'financeiro.dias_atraso': '3' },
      urgent: false,
    })

    const summary = await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(summary.sent).toBe(1)
    expect(email.sent).toHaveLength(1)
  })
})

describe('destino imposto', () => {
  it('recusa texto de marketing para contato fora da ficha', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { marketing: { email: true } })

    await expect(
      enqueueMessage(actor(fixture.tenantId), {
        recipientKind: 'TUTOR',
        tutorId,
        templateKey: 'campaign_broadcast',
        channel: 'EMAIL',
        dedupeKey: 'promo-fora-da-ficha',
        overrideAddress: 'outro@exemplo.com',
        variables: {},
        urgent: false,
      }),
    ).rejects.toMatchObject({ code: 'ERR_CRM_003' })
  })
})
