import { randomUUID } from 'node:crypto'
import { withTenant } from '@petshop/db'
import { allocateNumber } from '@petshop/documents'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdfUnavailableError, setPdfPort } from '../src/lib/pdf.js'
import { StorageUnavailableError, setStoragePort } from '../src/lib/storage.js'
import { recordPayment, reversePayment } from '../src/modules/ledger/payments.js'
import { renderReceiptHtml } from '../src/modules/ledger/receipt-template.js'
import { retryPendingReceipts } from '../src/modules/ledger/receipts.js'
import {
  actorOf,
  asAdmin,
  callApi,
  closeHarness,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * Recibo em PDF (MOD-LEDGER-08).
 *
 * O Gotenberg e o R2 são dublados — o que está sob teste aqui é a **numeração**, o
 * ciclo de vida e a degradação. Que o Gotenberg saiba converter HTML é problema do
 * Gotenberg, e `packages/pdf` já cobre o protocolo.
 */

let tenant: TenantFixture
let tutorId: string

interface FakePdf {
  calls: string[]
  failWith: Error | null
}

interface FakeStorage {
  objects: Map<string, Buffer>
  failWith: Error | null
}

let pdf: FakePdf
let storage: FakeStorage

function installFakes(): void {
  pdf = { calls: [], failWith: null }
  storage = { objects: new Map(), failWith: null }

  setPdfPort({
    async render(html) {
      if (pdf.failWith) throw pdf.failWith
      pdf.calls.push(html)
      return Buffer.from('%PDF-1.4 dublê')
    },
  })

  setStoragePort({
    async put(key, body) {
      if (storage.failWith) throw storage.failWith
      storage.objects.set(key, body)
    },
    async signedUrl(key) {
      return `https://r2.test/${key}?assinada=1`
    },
  })
}

beforeEach(async () => {
  await resetDatabase()
  installFakes()
  tenant = await givenTenant()
  tutorId = await givenTutor(tenant)
})

afterEach(() => {
  setPdfPort(null)
  setStoragePort(null)
})

afterAll(closeHarness)

async function pay(amountCents = 15000) {
  return recordPayment(actorOf(tenant), {
    tutorId,
    amountCents,
    method: 'PIX_MANUAL',
    receivedAt: new Date().toISOString(),
    idempotencyKey: randomUUID(),
  })
}

async function receiptOf(paymentId: string) {
  return withTenant(tenant.tenantId, (tx) =>
    tx.receipt.findFirstOrThrow({ where: { paymentId } }),
  )
}

/** O documento por trás do recibo: é ele que guarda arquivo, tentativas e erro. */
async function documentOf(paymentId: string) {
  return withTenant(tenant.tenantId, async (tx) => {
    const receipt = await tx.receipt.findFirstOrThrow({
      where: { paymentId },
      select: { documentId: true },
    })
    return tx.document.findFirstOrThrow({ where: { id: receipt.documentId! } })
  })
}

describe('RN-21 — numeração sequencial por tenant e ano', () => {
  it('o primeiro recibo do ano é 000001 e o próximo é 000002', async () => {
    const primeiro = await pay(1000)
    const segundo = await pay(1000)

    const ano = new Date().getUTCFullYear()
    expect((await receiptOf(primeiro.paymentId)).number).toBe(`${ano}/000001`)
    expect((await receiptOf(segundo.paymentId)).number).toBe(`${ano}/000002`)
  })

  it('cada tenant tem a própria sequência', async () => {
    const outro = await givenTenant('Outro Petshop')
    const outroTutor = await givenTutor(outro, 'João')

    const meu = await pay(1000)
    const dele = await recordPayment(
      { tenantId: outro.tenantId, actorUserId: outro.userId },
      {
        tutorId: outroTutor,
        amountCents: 1000,
        method: 'CASH',
        receivedAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      },
    )

    const ano = new Date().getUTCFullYear()
    expect((await receiptOf(meu.paymentId)).number).toBe(`${ano}/000001`)
    expect(
      (await withTenant(outro.tenantId, (tx) =>
        tx.receipt.findFirstOrThrow({ where: { paymentId: dele.paymentId } }),
      )).number,
    ).toBe(`${ano}/000001`)
  })

  it('a sequência recomeça a cada ano', async () => {
    const numero2025 = await withTenant(tenant.tenantId, (tx) =>
      allocateNumber(tx, tenant.tenantId, 'RECEIPT', 2025),
    )
    const numero2026 = await withTenant(tenant.tenantId, (tx) =>
      allocateNumber(tx, tenant.tenantId, 'RECEIPT', 2026),
    )

    expect(numero2025).toBe('2025/000001')
    expect(numero2026).toBe('2026/000001')
  })

  it('dez alocações simultâneas produzem dez números distintos', async () => {
    const numeros = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenant(tenant.tenantId, (tx) => allocateNumber(tx, tenant.tenantId, 'RECEIPT', 2026)),
      ),
    )

    expect(new Set(numeros).size).toBe(10)
  })

  it('recibo cancelado **não** devolve o número à sequência', async () => {
    const primeiro = await pay(1000)
    await reversePayment(actorOf(tenant), primeiro.paymentId, 'Lançado no tutor errado')

    const segundo = await pay(1000)
    const ano = new Date().getUTCFullYear()

    // Um buraco na sequência é pergunta que o contador sabe responder; um número
    // repetido é documento duplicado, que ele não sabe.
    expect((await receiptOf(segundo.paymentId)).number).toBe(`${ano}/000002`)
  })
})

describe('emissão', () => {
  it('o pagamento sai com o recibo já emitido e arquivado', async () => {
    const payment = await pay()
    const receipt = await receiptOf(payment.paymentId)

    expect(receipt.status).toBe('ISSUED')
    expect(receipt.issuedAt).not.toBeNull()
    const documento = await documentOf(payment.paymentId)
    expect(documento.status).toBe('ISSUED')
    expect(documento.storageKey).toBe(`tenants/${tenant.tenantId}/documents/${documento.id}.pdf`)
    expect(documento.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(storage.objects.get(documento.storageKey!)?.toString()).toContain('%PDF')
  })

  it('a rota devolve número, status e URL assinada — não o PDF em stream', async () => {
    const payment = await pay()

    const response = await callApi({
      method: 'GET',
      url: `/v1/payments/${payment.paymentId}/receipt`,
      ...asAdmin(tenant),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'ISSUED',
      number: expect.stringMatching(/^\d{4}\/\d{6}$/),
      url: expect.stringContaining('assinada=1'),
    })
  })

  it('o lançamento de crédito aponta para o pagamento — é como a tela acha o recibo', async () => {
    const payment = await pay()

    const entry = await withTenant(tenant.tenantId, (tx) =>
      tx.ledgerEntry.findFirstOrThrow({ where: { category: 'PAYMENT' } }),
    )

    expect(entry.sourceType).toBe('PAYMENT')
    expect(entry.sourceId).toBe(payment.paymentId)
  })

  it('a venda de pacote também gera recibo — o tutor pagou igual', async () => {
    const serviceId = await withTenant(tenant.tenantId, async (tx) => {
      const service = await tx.service.create({
        data: { tenantId: tenant.tenantId, name: 'Banho', category: 'BATH', baseDurationMin: 60 },
      })
      return service.id
    })
    const packageId = await withTenant(tenant.tenantId, async (tx) => {
      const pkg = await tx.servicePackage.create({
        data: {
          tenantId: tenant.tenantId,
          name: '4 Banhos',
          serviceIds: [serviceId],
          credits: 4,
          priceCents: 32000n,
        },
      })
      return pkg.id
    })

    const response = await callApi({
      method: 'POST',
      url: `/v1/packages/${packageId}/purchases`,
      ...asAdmin(tenant),
      payload: { tutorId, paymentMethod: 'CASH', idempotencyKey: randomUUID() },
    })
    expect(response.statusCode).toBe(201)

    const receipts = await withTenant(tenant.tenantId, (tx) => tx.receipt.findMany())
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.status).toBe('ISSUED')
  })
})

describe('degradação — o comprovante falha, o pagamento não', () => {
  it('Gotenberg fora do ar deixa o recibo PENDENTE e o pagamento entra', async () => {
    pdf.failWith = new PdfUnavailableError('Gotenberg indisponível')

    const payment = await pay()
    const receipt = await receiptOf(payment.paymentId)

    // O que importa: o dinheiro foi registrado.
    expect(payment.paymentId).toBeTruthy()
    expect(receipt.status).toBe('PENDING')
    expect(receipt.number).toBeTruthy()
    const documento = await documentOf(payment.paymentId)
    expect(documento.status).toBe('PENDING')
    expect(documento.lastError).toContain('Gotenberg')
    expect(documento.attempts).toBe(1)
  })

  it('bucket fora do ar também só deixa pendente', async () => {
    storage.failWith = new StorageUnavailableError('bucket indisponível')

    const payment = await pay()
    expect((await receiptOf(payment.paymentId)).status).toBe('PENDING')
  })

  it('a rota devolve o recibo pendente com `url` nula, não 502', async () => {
    pdf.failWith = new PdfUnavailableError('Gotenberg indisponível')
    const payment = await pay()

    const response = await callApi({
      method: 'GET',
      url: `/v1/payments/${payment.paymentId}/receipt`,
      ...asAdmin(tenant),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'PENDING', url: null })
    expect(response.json().number).toBeTruthy()
  })

  it('o job reprocessa quando o Gotenberg volta', async () => {
    pdf.failWith = new PdfUnavailableError('Gotenberg indisponível')
    const payment = await pay()
    expect((await receiptOf(payment.paymentId)).status).toBe('PENDING')

    pdf.failWith = null
    const result = await retryPendingReceipts()

    expect(result.issued).toBe(1)
    expect((await receiptOf(payment.paymentId)).status).toBe('ISSUED')
  })

  it('o job não mexe no que já está emitido', async () => {
    await pay()
    expect((await retryPendingReceipts()).issued).toBe(0)
  })

  it('recibo pendente com documento já emitido é reconciliado sem gerar segundo PDF', async () => {
    // A divergência: o processo morreu entre arquivar o documento e marcar o recibo.
    // Sem a guarda de imutabilidade, a segunda passada sobrescreveria o arquivo que o
    // tutor já recebeu; sem esta reconciliação, o recibo ficaria pendurado para sempre.
    const payment = await pay()
    await withTenant(tenant.tenantId, (tx) =>
      tx.receipt.updateMany({
        where: { paymentId: payment.paymentId },
        data: { status: 'PENDING', issuedAt: null },
      }),
    )
    expect(pdf.calls).toHaveLength(1)

    const result = await retryPendingReceipts()

    expect(result.issued).toBe(1)
    expect((await receiptOf(payment.paymentId)).status).toBe('ISSUED')
    // O arquivo é o mesmo: nenhuma segunda renderização.
    expect(pdf.calls).toHaveLength(1)
  })
})

describe('ciclo de vida', () => {
  it('reverter o pagamento cancela o recibo sem apagar o arquivo', async () => {
    const payment = await pay()
    const antes = await receiptOf(payment.paymentId)
    expect(antes.status).toBe('ISSUED')

    await reversePayment(actorOf(tenant), payment.paymentId, 'Cliente desistiu')

    const depois = await receiptOf(payment.paymentId)
    expect(depois.status).toBe('CANCELLED')
    expect(depois.cancelledAt).not.toBeNull()
    // Retenção contábil vale para o comprovante também: o que muda é o status.
    const documento = await documentOf(payment.paymentId)
    expect(documento.status).toBe('CANCELLED')
    expect(documento.storageKey).not.toBeNull()
    expect(storage.objects.has(documento.storageKey!)).toBe(true)
  })

  it('emitir de novo um recibo já emitido não gera segundo PDF', async () => {
    const payment = await pay()
    expect(pdf.calls).toHaveLength(1)

    await callApi({
      method: 'GET',
      url: `/v1/payments/${payment.paymentId}/receipt`,
      ...asAdmin(tenant),
    })
    expect(pdf.calls).toHaveLength(1)
  })
})

describe('o que o papel diz', () => {
  it('avisa que não é nota fiscal, mesmo sem texto configurado (RN-20)', async () => {
    await pay()
    const html = pdf.calls[0] ?? ''

    expect(html).toContain('não substitui nota fiscal')
  })

  it('mostra valor, forma de pagamento e o que foi quitado', async () => {
    await callApi({
      method: 'POST',
      url: '/v1/ledger/entries',
      ...asAdmin(tenant),
      payload: {
        tutorId,
        direction: 'DEBIT',
        amountCents: 15000,
        category: 'SERVICE',
        description: 'Banho e Tosa',
        idempotencyKey: randomUUID(),
      },
    })
    await pay(15000)

    const html = pdf.calls[0] ?? ''
    // `formatBRL` usa o espaço não separável do `Intl` (U+00A0), não `&nbsp;`.
    expect(html).toContain(`R$\u00a0150,00`)
    expect(html).toContain('PIX')
    expect(html).toContain('Banho e Tosa')
    expect(html).toContain('Conta quitada')
  })

  it('escapa campo livre — o Gotenberg roda um Chromium de verdade', () => {
    const html = renderReceiptHtml({
      number: '2026/000001',
      issuer: {
        name: 'Petshop <b>Teste</b>',
        legalName: null,
        cnpj: null,
        address: null,
        phone: '(11) 99999-0000',
        logoUrl: null,
        primaryColor: null,
      },
      timezone: 'America/Sao_Paulo',
      tutorName: '<script>alert(1)</script>',
      amountCents: 1000,
      method: 'CASH',
      receivedAt: new Date(),
      issuedAt: new Date(),
      allocations: [],
      creditCents: 0,
      balanceAfterCents: 0,
      footerText: null,
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Petshop &lt;b&gt;Teste&lt;/b&gt;')
  })

  it('o saldo aparece em português, não como número com sinal', () => {
    const base = {
      number: '2026/000001',
      issuer: {
        name: 'Petshop',
        legalName: null,
        cnpj: null,
        address: null,
        phone: '(11) 99999-0000',
        logoUrl: null,
        primaryColor: null,
      },
      timezone: 'America/Sao_Paulo',
      tutorName: 'Maria',
      amountCents: 1000,
      method: 'CASH' as const,
      receivedAt: new Date(),
      issuedAt: new Date(),
      allocations: [],
      creditCents: 0,
      footerText: null,
    }

    expect(renderReceiptHtml({ ...base, balanceAfterCents: 0 })).toContain('Conta quitada')
    expect(renderReceiptHtml({ ...base, balanceAfterCents: -5000 })).toContain('em aberto')
    expect(renderReceiptHtml({ ...base, balanceAfterCents: 5000 })).toContain('de crédito')
  })
})
