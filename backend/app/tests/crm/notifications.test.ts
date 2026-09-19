import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  handleTenantEmAtraso,
  handleTenantSuspenso,
  handleTenantTesteTerminando,
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

// ─── Os avisos da conta ──────────────────────────────────────────────────────

describe('os avisos da conta', () => {
  /** Um segundo administrador: quem cobra não pode depender de uma caixa de entrada só. */
  async function givenOutroAdmin(): Promise<string> {
    const suffix = randomUUID().slice(0, 8)
    const user = await ownerPrisma.user.create({
      data: {
        clerkUserId: `user_${suffix}`,
        emailEncrypted: 'v1:x:x:x',
        emailHash: `hash-${suffix}`,
        fullName: 'Sócia de Teste',
      },
    })
    await ownerPrisma.membership.create({
      data: {
        tenantId: fixture.tenantId,
        userId: user.id,
        roleKey: 'TENANT_ADMIN',
        status: 'ACTIVE',
      },
    })
    return user.id
  }

  async function givenAssinatura(data: { overdueSince?: Date; paymentUrl?: string }) {
    await ownerPrisma.tenantSubscription.create({
      data: {
        tenantId: fixture.tenantId,
        plan: 'PRO',
        method: 'PIX',
        status: 'PAST_DUE',
        ...data,
      },
    })
  }

  /** Congela o relógio: a contagem de dias é relativa a hoje, e hoje anda. */
  function hojeEm(iso: string) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(iso))
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('avisa da véspera do fim do teste, com os dias e a data no fuso do petshop', async () => {
    hojeEm('2026-09-12T12:00:00.000Z')

    await handleTenantTesteTerminando({
      tenantId: fixture.tenantId,
      // Meia-noite e meia UTC do dia 15 ainda é dia 14 em São Paulo: é o caso que prova
      // que a data sai no fuso do estabelecimento, e não no do servidor.
      trialEndsAt: '2026-09-15T00:30:00.000Z',
    })

    expect(messaging.requests).toHaveLength(1)
    const request = messaging.requests[0]!
    expect(request.templateKey).toBe('trial_ending')
    expect(request.recipientKind).toBe('USER')
    expect(request.userId).toBe(fixture.userId)
    expect(request.variables?.['conta.vence_em']).toBe('14 de setembro')
    // 12 → 14 em São Paulo são dois dias, e é o que o texto tem de dizer ao lado da data.
    expect(request.variables?.['conta.prazo']).toBe('em 2 dias')
    // A chave é o vencimento, e não o dia do envio: a varredura publica de novo a cada
    // passada, e um teste **estendido** merece o aviso do prazo novo.
    expect(request.dedupeKey).toContain('2026-09-15')
  })

  /**
   * O defeito que só o e-mail de verdade mostrou (2026-09-19): 2,5 dias de diferença
   * viravam "3 dias" por arredondamento, ao lado de uma data que estava a 2 dias de quem
   * lia. A contagem de calendário não tem como divergir da data que ela acompanha.
   */
  it('conta dias de calendário, não frações de 24 horas', async () => {
    hojeEm('2026-09-19T14:41:00.000Z') // 11h41 em São Paulo

    await handleTenantTesteTerminando({
      tenantId: fixture.tenantId,
      trialEndsAt: '2026-09-22T02:41:00.000Z', // 23h41 do dia 21 em São Paulo
    })

    const request = messaging.requests[0]!
    expect(request.variables?.['conta.vence_em']).toBe('21 de setembro')
    expect(request.variables?.['conta.prazo']).toBe('em 2 dias')
  })

  it('o último dia é "amanhã", e nunca "em 1 dias"', async () => {
    hojeEm('2026-09-19T14:00:00.000Z')

    await handleTenantTesteTerminando({
      tenantId: fixture.tenantId,
      trialEndsAt: '2026-09-19T23:00:00.000Z', // 20h do mesmo dia em São Paulo
    })

    // Zero seria o corte falando, e o corte tem aviso próprio. E o molde traz o prazo
    // inteiro justamente para não sair "em 1 dias" — um em cada três avisos.
    expect(messaging.requests[0]!.variables?.['conta.prazo']).toBe('amanhã')
  })

  it('manda o aviso a todo administrador, com dedupeKey por destinatário', async () => {
    const outro = await givenOutroAdmin()

    await handleTenantTesteTerminando({
      tenantId: fixture.tenantId,
      trialEndsAt: '2026-09-20T12:00:00.000Z',
    })

    expect(messaging.requests).toHaveLength(2)
    const destinatarios = messaging.requests.map((request) => request.userId).sort()
    expect(destinatarios).toEqual([fixture.userId, outro].sort())

    // Sem o destinatário na chave, o motor devolveria a mesma mensagem duas vezes e só o
    // primeiro administrador receberia.
    const chaves = new Set(messaging.requests.map((request) => request.dedupeKey))
    expect(chaves.size).toBe(2)
  })

  it('no atraso, aponta para a cobrança em aberto e diz até quando dá para trabalhar', async () => {
    await givenAssinatura({
      overdueSince: new Date('2026-09-10T12:00:00.000Z'),
      paymentUrl: 'https://asaas.exemplo/cobranca/abc',
    })

    await handleTenantEmAtraso({
      tenantId: fixture.tenantId,
      previousStatus: 'ACTIVE',
      newStatus: 'PAST_DUE',
      reason: 'PAYMENT_OVERDUE',
    })

    expect(messaging.requests).toHaveLength(1)
    const request = messaging.requests[0]!
    expect(request.templateKey).toBe('subscription_past_due')
    expect(request.variables?.['conta.link_pagamento']).toBe('https://asaas.exemplo/cobranca/abc')
    // Sete dias de carência depois do vencimento (BILLING_GRACE_DAYS).
    expect(request.variables?.['conta.vence_em']).toBe('17 de setembro')
    // A chave é a data em que o atraso começou: quem atrasar de novo em dezembro recebe
    // um aviso novo, e não uma repetição suprimida.
    expect(request.dedupeKey).toContain('2026-09-10')
  })

  it('não manda "sua conta foi suspensa" a quem pediu para cancelar', async () => {
    await handleTenantSuspenso({
      tenantId: fixture.tenantId,
      previousStatus: 'ACTIVE',
      newStatus: 'SUSPENDED',
      reason: 'CANCELLED_BY_TENANT',
    })
    expect(messaging.requests).toHaveLength(0)

    // E o fim do teste também não: ele tem o aviso dele, na véspera.
    await handleTenantSuspenso({
      tenantId: fixture.tenantId,
      previousStatus: 'TRIAL',
      newStatus: 'TRIAL_EXPIRED',
      reason: 'TRIAL_EXPIRED',
    })
    expect(messaging.requests).toHaveLength(0)

    await handleTenantSuspenso({
      tenantId: fixture.tenantId,
      previousStatus: 'PAST_DUE',
      newStatus: 'SUSPENDED',
      reason: 'OVERDUE_GRACE_ENDED',
    })
    expect(messaging.requests).toHaveLength(1)
    expect(messaging.requests[0]!.templateKey).toBe('tenant_suspended')
  })
})
