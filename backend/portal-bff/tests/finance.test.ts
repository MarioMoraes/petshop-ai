import { AppError } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  asVisitor,
  callApi,
  closeHarness,
  fakeLedger,
  givenEntry,
  givenLedgerAccount,
  givenPackagePurchase,
  givenPayment,
  givenPet,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type LedgerDouble,
  type TenantFixture,
} from './harness.js'

/**
 * MOD-PORTAL-08 — o extrato e os recibos.
 *
 * O cálculo do saldo, a alocação do pagamento e a numeração do recibo têm suíte própria
 * no `billing-ledger-service`. O que **esta** guarda é o que o BFF acrescenta:
 *
 * - o recorte por tutor, na consulta e não depois dela;
 * - a nota interna que nunca sai (AC-02) — a garantia mais valiosa do módulo;
 * - a posse do pagamento, provada antes de a porta elevar permissão;
 * - o que a tela precisa para não mentir: sinal do saldo, pacote expirando, ausência de
 *   botão de pagar.
 */

let fixture: TenantFixture
let ledger: LedgerDouble

function diasAFrente(dias: number): Date {
  return new Date(Date.now() + dias * 86_400_000)
}

function diasAtras(dias: number): Date {
  return new Date(Date.now() - dias * 86_400_000)
}

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  ledger = await fakeLedger()
})

afterAll(async () => {
  await closeHarness()
})

describe('GET /portal/v1/finance', () => {
  it('AC-01: devolve saldo devedor, o que está em aberto e desde quando', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, -18000)
    await givenEntry(fixture, tutorId, accountId, {
      direction: 'DEBIT',
      amountCents: 18000,
      description: 'Banho e tosa',
      occurredAt: diasAtras(10),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    // Negativo é dívida — a convenção do RN-02, que a tela lê por `portalOwesCents`.
    expect(body.balanceCents).toBe(-18000)
    expect(body.openDebitsCents).toBe(18000)
    expect(body.oldestOpenDebitAt).not.toBeNull()
  })

  it('AC-04 de MOD-LEDGER-06: tutor sem movimentação vê zero, não 404', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().balanceCents).toBe(0)
    expect(response.json().openDebitsCents).toBe(0)
    expect(response.json().packages).toEqual([])
  })

  it('o débito já quitado sai do "em aberto" mas continua no extrato', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    await givenEntry(fixture, tutorId, accountId, {
      direction: 'DEBIT',
      amountCents: 8000,
      settledCents: 8000,
      description: 'Banho de setembro',
      occurredAt: diasAtras(3),
    })

    const painel = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })
    expect(painel.json().openDebitsCents).toBe(0)

    const extrato = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement',
      ...asTutor(fixture, tutorId),
    })
    expect(extrato.json().entries).toHaveLength(1)
  })

  it('AC-04: o pacote ativo mostra créditos restantes e a data de expiração', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    const petId = await givenPet(fixture, tutorId, { name: 'Thor' })
    await givenPackagePurchase(fixture, tutorId, accountId, {
      creditsTotal: 4,
      creditsUsed: 3,
      expiresAt: diasAFrente(60),
      petId,
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    const [pacote] = response.json().packages
    expect(pacote.creditsRemaining).toBe(1)
    expect(pacote.creditsTotal).toBe(4)
    expect(pacote.petName).toBe('Thor')
    // Longe do vencimento: a data aparece, o alerta não.
    expect(pacote.expiringSoon).toBe(false)
  })

  it('RN-09 de MOD-LEDGER: o pacote perto de vencer é sinalizado antes, não depois', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    await givenPackagePurchase(fixture, tutorId, accountId, {
      creditsTotal: 4,
      creditsUsed: 1,
      // Dentro da janela padrão de aviso do tenant (`[15, 3]`).
      expiresAt: diasAFrente(10),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().packages[0].expiringSoon).toBe(true)
  })

  it('pacote expirado ou esgotado não aparece como saldo do tutor', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    await givenPackagePurchase(fixture, tutorId, accountId, {
      creditsTotal: 4,
      creditsUsed: 4,
      expiresAt: diasAtras(1),
      status: 'EXPIRED',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().packages).toEqual([])
  })

  it('AC-05: entrega a chave PIX e o horário, e nenhuma forma de pagar aqui', async () => {
    const tutorId = await givenTutor(fixture)
    await ownerPrisma.billingSettings.create({
      data: {
        tenantId: fixture.tenantId,
        enabledPaymentMethods: ['PIX_MANUAL'],
        pixKey: 'contato@petshopdojoao.com.br',
      },
    })
    await ownerPrisma.tenantSettings.update({
      where: { tenantId: fixture.tenantId },
      data: { publicPhone: '(11) 3333-4444' },
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    const body = response.json()
    expect(body.howToPay.pixKey).toBe('contato@petshopdojoao.com.br')
    expect(body.howToPay.phone).toBe('(11) 3333-4444')
    expect(body.howToPay.hours.length).toBeGreaterThan(0)
    // Não há PSP na v1: nada na resposta descreve um checkout.
    expect(JSON.stringify(body)).not.toContain('checkout')
  })

  it('o tenant que não configurou PIX devolve nulo, e não uma chave vazia', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().howToPay.pixKey).toBeNull()
  })

  it('RN-03: a conta de outro tutor não é alcançável — o escopo é o do contexto', async () => {
    const tutorId = await givenTutor(fixture)
    const outro = await givenTutor(fixture, { phone: '+5511999998888' })
    const contaAlheia = await givenLedgerAccount(fixture, outro, -50000)
    await givenEntry(fixture, outro, contaAlheia, {
      direction: 'DEBIT',
      amountCents: 50000,
      description: 'Internação',
      occurredAt: diasAtras(2),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asTutor(fixture, tutorId),
    })

    // O filtro é `tutorId` na consulta: não há parâmetro que o tutor possa trocar.
    expect(response.json().balanceCents).toBe(0)
    expect(response.json().openDebitsCents).toBe(0)
  })

  it('quem entrou no Clerk mas não vinculou ficha não alcança a rota', async () => {
    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance',
      ...asVisitor(fixture),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('GET /portal/v1/finance/statement', () => {
  it('AC-01: lança em ordem de fato gerador, com o sinal já resolvido', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, -10000)
    await givenEntry(fixture, tutorId, accountId, {
      direction: 'DEBIT',
      amountCents: 18000,
      description: 'Banho e tosa',
      occurredAt: diasAtras(10),
    })
    await givenPayment(fixture, tutorId, accountId, {
      amountCents: 8000,
      receivedAt: diasAtras(2),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.total).toBe(2)
    // Mais recente primeiro: o pagamento de dois dias atrás vem antes do banho.
    expect(body.entries[0].amountCents).toBe(8000)
    expect(body.entries[1].amountCents).toBe(-18000)
  })

  it('AC-02: a nota interna do lançamento não viaja até o Portal', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, -8000)
    await givenEntry(fixture, tutorId, accountId, {
      direction: 'DEBIT',
      amountCents: 8000,
      description: 'Banho',
      occurredAt: diasAtras(1),
      internalNotes: 'Dei desconto porque ela reclamou',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement',
      ...asTutor(fixture, tutorId),
    })

    // Nem o texto, nem o campo cifrado, nem o nome da coluna.
    const corpo = response.payload
    expect(corpo).not.toContain('reclamou')
    expect(corpo).not.toContain('internalNotes')
    expect(corpo).not.toContain('internal_notes')
  })

  it('o lançamento estornado aparece marcado, e não some do extrato', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    await givenEntry(fixture, tutorId, accountId, {
      direction: 'DEBIT',
      amountCents: 8000,
      description: 'Cobrança indevida',
      occurredAt: diasAtras(5),
      status: 'REVERSED',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().entries).toHaveLength(1)
    expect(response.json().entries[0].reversed).toBe(true)
  })

  it('só a linha do pagamento oferece recibo', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    await givenEntry(fixture, tutorId, accountId, {
      direction: 'DEBIT',
      amountCents: 8000,
      description: 'Banho',
      occurredAt: diasAtras(4),
    })
    const { paymentId } = await givenPayment(fixture, tutorId, accountId, {
      amountCents: 8000,
      receivedAt: diasAtras(1),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement',
      ...asTutor(fixture, tutorId),
    })

    const [pagamento, debito] = response.json().entries
    expect(pagamento.paymentId).toBe(paymentId)
    expect(debito.paymentId).toBeNull()
  })

  it('pagina por página, porque a data do fato gerador repete', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    const mesmoInstante = diasAtras(1)

    for (const label of ['Banho', 'Tosa', 'Hidratação']) {
      await givenEntry(fixture, tutorId, accountId, {
        direction: 'DEBIT',
        amountCents: 5000,
        description: label,
        // Três serviços do mesmo dia lançados juntos: um cursor por data pularia ou
        // repetiria linhas, e é por isso que a paginação aqui é por página.
        occurredAt: mesmoInstante,
      })
    }

    const primeira = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement?page=1&limit=2',
      ...asTutor(fixture, tutorId),
    })
    const segunda = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement?page=2&limit=2',
      ...asTutor(fixture, tutorId),
    })

    expect(primeira.json().total).toBe(3)
    expect(primeira.json().entries).toHaveLength(2)
    expect(segunda.json().entries).toHaveLength(1)

    const ids = [
      ...primeira.json().entries.map((entry: { id: string }) => entry.id),
      ...segunda.json().entries.map((entry: { id: string }) => entry.id),
    ]
    expect(new Set(ids).size).toBe(3)
  })

  it('o extrato de outro tutor não é alcançável', async () => {
    const tutorId = await givenTutor(fixture)
    const outro = await givenTutor(fixture, { phone: '+5511999997777' })
    const contaAlheia = await givenLedgerAccount(fixture, outro, -50000)
    await givenEntry(fixture, outro, contaAlheia, {
      direction: 'DEBIT',
      amountCents: 50000,
      description: 'Internação',
      occurredAt: diasAtras(2),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().entries).toEqual([])
  })
})

describe('GET /portal/v1/finance/statement/pdf', () => {
  it('AC-02 de MOD-DOC-09: desce os bytes do extrato e registra o acesso', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement/pdf',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="extrato-2026-09-07.pdf"',
    )
    // A conta corrente do titular não fica no cache de nenhum intermediário.
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')

    // O `tutorId` que chegou ao ledger é o do `ownScope`, não um da URL.
    expect(ledger.calls).toEqual([tutorId])

    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId, action: 'portal.statement_downloaded' },
    })
    expect(trilha?.entityId).toBe(tutorId)
  })

  it('quem entrou no Clerk mas não vinculou ficha não alcança o extrato', async () => {
    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement/pdf',
      ...asVisitor(fixture),
    })

    expect(response.statusCode).toBe(403)
    expect(ledger.calls).toEqual([])
  })

  it('o Gotenberg fora do ar atravessa como 503, e não como folha vazia', async () => {
    const tutorId = await givenTutor(fixture)
    ledger.failWith = new AppError('ERR_LEDGER_013', 'Geração de documento indisponível')

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/finance/statement/pdf',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(503)
  })
})

describe('GET /portal/v1/finance/receipts/:paymentId', () => {
  it('AC-03: devolve a URL assinada do recibo e registra o acesso', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    const { paymentId } = await givenPayment(fixture, tutorId, accountId, {
      amountCents: 8000,
      receivedAt: diasAtras(1),
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/finance/receipts/${paymentId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().number).toBe('2026/000123')
    expect(response.json().url).toContain('https://')
    expect(ledger.calls).toEqual([paymentId])

    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId, action: 'portal.receipt_accessed' },
    })
    expect(trilha?.entityId).toBe(paymentId)
  })

  it('RN-03: o recibo de outro tutor responde 404 e a porta nem é chamada', async () => {
    const tutorId = await givenTutor(fixture)
    const outro = await givenTutor(fixture, { phone: '+5511999996666' })
    const contaAlheia = await givenLedgerAccount(fixture, outro, 0)
    const { paymentId } = await givenPayment(fixture, outro, contaAlheia, {
      amountCents: 30000,
      receivedAt: diasAtras(1),
    })

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/finance/receipts/${paymentId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_PORTAL_001')
    // A prova de que a permissão não foi elevada por um pagamento alheio.
    expect(ledger.calls).toEqual([])
  })

  it('recibo ainda em preparo devolve número sem URL, e não um link morto', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    const { paymentId } = await givenPayment(fixture, tutorId, accountId, {
      amountCents: 8000,
      receivedAt: diasAtras(1),
    })
    ledger.receipt = { number: '2026/000124', status: 'PENDING', issuedAt: null, url: null }

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/finance/receipts/${paymentId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('PENDING')
    expect(response.json().url).toBeNull()
  })

  it('erro do ledger atravessa com o código original', async () => {
    const tutorId = await givenTutor(fixture)
    const accountId = await givenLedgerAccount(fixture, tutorId, 0)
    const { paymentId } = await givenPayment(fixture, tutorId, accountId, {
      amountCents: 8000,
      receivedAt: diasAtras(1),
    })
    ledger.failWith = new AppError('ERR_LEDGER_001', 'Recibo não encontrado para este pagamento')

    const response = await callApi({
      method: 'GET',
      url: `/portal/v1/finance/receipts/${paymentId}`,
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().code).toBe('ERR_LEDGER_001')
  })
})
