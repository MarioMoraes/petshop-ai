import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  closeHarness,
  getApp,
  givenTenant,
  givenTutorWithPet,
  installFakeMessagingPort,
  ownerPrisma,
  resetDatabase,
  type FakeMessaging,
  type TenantFixture,
} from './fixtures.js'
import {
  handleConviteAceito,
  handleOnboardingConcluido,
  handlePrescricaoEmitida,
  handleReciboEmitido,
} from '../../src/modules/crm/notifications.js'

/**
 * MOD-NOTIF fatia 2 — os avisos que o produto manda (sub-features 06 a 09).
 *
 * Os handlers são exercitados direto, e não pelo broker: `DISABLE_EVENTS` está ligado no
 * harness, e o que interessa provar é a tradução de fato do domínio em pedido de envio.
 * O que o messaging faz com o pedido tem suíte própria, do outro lado.
 */

let fixture: TenantFixture
let messaging: FakeMessaging

beforeAll(async () => {
  await getApp()
})

afterAll(async () => {
  await closeHarness()
})

beforeEach(async () => {
  await resetDatabase()
  messaging = installFakeMessagingPort()
  fixture = await givenTenant()
})

/** Um documento arquivado, como o MOD-DOC o deixa. */
async function givenDocument(
  options: { tutorId?: string; kind?: 'RECEIPT' | 'PRESCRIPTION' } = {},
): Promise<{ id: string; number: string }> {
  const kind = options.kind ?? 'RECEIPT'
  return withTenant(fixture.tenantId, async (tx) => {
    const document = await tx.document.create({
      data: {
        tenantId: fixture.tenantId,
        kind,
        number: `${kind === 'RECEIPT' ? '' : 'RX-'}2026/000123`,
        ...(options.tutorId ? { tutorId: options.tutorId } : {}),
        status: 'ISSUED',
        issuedAt: new Date(),
        storageKey: `tenants/${fixture.tenantId}/documents/x.pdf`,
        sizeBytes: 1024,
      },
    })
    return { id: document.id, number: document.number }
  })
}

// ─── MOD-NOTIF-06 — recibo por e-mail ────────────────────────────────────────

describe('MOD-NOTIF-06 — recibo por e-mail', () => {
  it('AC-01: enfileira o recibo com o documento anexo e o valor formatado', async () => {
    const { tutorId } = await givenTutorWithPet(fixture)
    const document = await givenDocument({ tutorId })

    await handleReciboEmitido({
      tenantId: fixture.tenantId,
      receiptId: randomUUID(),
      paymentId: randomUUID(),
      tutorId,
      number: document.number,
      documentId: document.id,
      amount: 'R$ 180,00',
    })

    expect(messaging.requests).toHaveLength(1)
    const request = messaging.requests[0]!
    expect(request.templateKey).toBe('receipt_issued')
    expect(request.tutorId).toBe(tutorId)
    expect(request.documentId).toBe(document.id)
    // Já formatado pelo publicador: o template não faz conta, e centavos escapando
    // para o corpo é o erro mais caro que o catálogo pode cometer.
    expect(request.variables['financeiro.valor_pago']).toBe('R$ 180,00')
  })

  it('AC-03: reprocesso do evento não manda o recibo duas vezes', async () => {
    const { tutorId } = await givenTutorWithPet(fixture)
    const document = await givenDocument({ tutorId })
    const event = {
      tenantId: fixture.tenantId,
      receiptId: randomUUID(),
      paymentId: randomUUID(),
      tutorId,
      number: document.number,
      documentId: document.id,
      amount: 'R$ 10,00',
    }

    await handleReciboEmitido(event)
    await handleReciboEmitido(event)

    // Os dois chegam à porta; quem recusa o segundo é o `dedupeKey` do outro lado, e
    // por isso a chave precisa ser a mesma nas duas passadas.
    expect(new Set(messaging.requests.map((request) => request.dedupeKey)).size).toBe(1)
    expect(messaging.requests[0]?.dedupeKey).toBe(`receipt-issued:${document.id}`)
  })

  it('recibo anterior ao MOD-DOC, sem documento, não vira e-mail vazio', async () => {
    const { tutorId } = await givenTutorWithPet(fixture)

    await handleReciboEmitido({
      tenantId: fixture.tenantId,
      receiptId: randomUUID(),
      paymentId: randomUUID(),
      tutorId,
      number: '2026/000001',
      documentId: null,
    })

    expect(messaging.requests).toHaveLength(0)
  })
})

// ─── MOD-NOTIF-07 — documento por e-mail ─────────────────────────────────────

describe('MOD-NOTIF-07 — documento por e-mail', () => {
  it('AC-01: o receituário chega ao titular com o pet no assunto', async () => {
    const { tutorId, petId } = await givenTutorWithPet(fixture)
    const document = await givenDocument({ tutorId, kind: 'PRESCRIPTION' })

    await handlePrescricaoEmitida({
      tenantId: fixture.tenantId,
      documentId: document.id,
      number: document.number,
      petId,
      tutorId,
    })

    const request = messaging.requests[0]!
    expect(request.templateKey).toBe('document_issued')
    expect(request.documentId).toBe(document.id)
    expect(request.petId).toBe(petId)
    expect(request.variables['documento.tipo']).toBe('Receituário')
    expect(request.variables['pet.nome']).toBeTruthy()
  })

  it('AC-02: documento sem titular não vira mensagem nenhuma', async () => {
    const { petId } = await givenTutorWithPet(fixture)
    const document = await givenDocument({ kind: 'PRESCRIPTION' })

    await handlePrescricaoEmitida({
      tenantId: fixture.tenantId,
      documentId: document.id,
      number: document.number,
      petId,
      tutorId: null,
    })

    // Filtra-se por **titularidade**, não por tipo: um tipo novo nasce fora por padrão,
    // em vez de vazar por esquecimento.
    expect(messaging.requests).toHaveLength(0)
  })
})

// ─── MOD-NOTIF-08 e 09 — as boas-vindas ──────────────────────────────────────

describe('MOD-NOTIF-08 — boas-vindas do estabelecimento', () => {
  it('AC-01: o administrador que terminou o wizard recebe, como USER', async () => {
    await handleOnboardingConcluido({
      tenantId: fixture.tenantId,
      adminUserId: fixture.userId,
    })

    const request = messaging.requests[0]!
    expect(request.templateKey).toBe('tenant_welcome')
    expect(request.recipientKind).toBe('USER')
    expect(request.userId).toBe(fixture.userId)
    expect(request.tutorId).toBeUndefined()
  })

  it('AC-03: o evento repetido usa a mesma chave, e o tenant é a chave', async () => {
    await handleOnboardingConcluido({ tenantId: fixture.tenantId, adminUserId: fixture.userId })
    await handleOnboardingConcluido({ tenantId: fixture.tenantId, adminUserId: fixture.userId })

    expect(messaging.requests[0]?.dedupeKey).toBe(`tenant-welcome:${fixture.tenantId}`)
    expect(new Set(messaging.requests.map((request) => request.dedupeKey)).size).toBe(1)
  })

  it('sem ator não se adivinha destinatário', async () => {
    await handleOnboardingConcluido({ tenantId: fixture.tenantId, adminUserId: null })
    expect(messaging.requests).toHaveLength(0)
  })
})

describe('MOD-NOTIF-09 — boas-vindas de membro da equipe', () => {
  it('AC-01: o aceite do convite manda o papel por extenso', async () => {
    const invitationId = randomUUID()

    await handleConviteAceito({
      tenantId: fixture.tenantId,
      invitationId,
      userId: fixture.userId,
      roleKey: 'RECEPTIONIST',
    })

    const request = messaging.requests[0]!
    expect(request.templateKey).toBe('user_welcome')
    expect(request.recipientKind).toBe('USER')
    expect(request.dedupeKey).toBe(`user-welcome:${invitationId}`)
    // A chave crua no corpo do e-mail leria como erro de sistema.
    expect(request.variables['equipe.papel']).not.toBe('RECEPTIONIST')
    expect(request.variables['equipe.papel']).toBeTruthy()
  })

  it('AC-02: o funcionário que também é tutor recebe duas mensagens distintas', async () => {
    const { tutorId } = await givenTutorWithPet(fixture)
    const document = await givenDocument({ tutorId })

    await handleConviteAceito({
      tenantId: fixture.tenantId,
      invitationId: randomUUID(),
      userId: fixture.userId,
      roleKey: 'GROOMER',
    })
    await handleReciboEmitido({
      tenantId: fixture.tenantId,
      receiptId: randomUUID(),
      paymentId: randomUUID(),
      tutorId,
      number: document.number,
      documentId: document.id,
      amount: 'R$ 90,00',
    })

    expect(messaging.requests).toHaveLength(2)
    expect(messaging.requests[0]?.recipientKind).toBe('USER')
    expect(messaging.requests[1]?.recipientKind).toBeUndefined()
    expect(messaging.requests[1]?.tutorId).toBe(tutorId)
  })

  it('convite novo depois de uma saída manda de novo', async () => {
    await handleConviteAceito({
      tenantId: fixture.tenantId,
      invitationId: randomUUID(),
      userId: fixture.userId,
      roleKey: 'GROOMER',
    })
    await handleConviteAceito({
      tenantId: fixture.tenantId,
      invitationId: randomUUID(),
      userId: fixture.userId,
      roleKey: 'MANAGER',
    })

    // A chave é do **convite**, não do usuário: quem volta à equipe é recebido de novo.
    expect(new Set(messaging.requests.map((request) => request.dedupeKey)).size).toBe(2)
  })
})

describe('os quatro não passam pelo interruptor das automações', () => {
  it('o tenant sem nenhuma automação ligada continua entregando o recibo', async () => {
    const { tutorId } = await givenTutorWithPet(fixture)
    const document = await givenDocument({ tutorId })

    const automacoes = await ownerPrisma.automation.count({
      where: { tenantId: fixture.tenantId, enabled: true },
    })
    expect(automacoes).toBe(0)

    await handleReciboEmitido({
      tenantId: fixture.tenantId,
      receiptId: randomUUID(),
      paymentId: randomUUID(),
      tutorId,
      number: document.number,
      documentId: document.id,
      amount: 'R$ 50,00',
    })

    // Não há interruptor para o petshop desligar o e-mail que entrega o comprovante
    // que ele mesmo emitiu.
    expect(messaging.requests).toHaveLength(1)
  })
})
