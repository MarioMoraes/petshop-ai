import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import type { PaymentMethod } from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { logger, recordMetric } from '../../lib/logger.js'
import { PdfUnavailableError, isPdfConfigured, renderPdf } from '../../lib/pdf.js'
import {
  RECEIPT_URL_TTL_SECONDS,
  StorageUnavailableError,
  getStorage,
  receiptKey,
} from '../../lib/storage.js'
import type { ActorContext } from './actor.js'
import { tenantOptions } from './actor.js'
import { renderReceiptHtml, type ReceiptAllocationLine } from './receipt-template.js'
import { loadSettings } from './settings.js'

/**
 * Recibo de pagamento (MOD-LEDGER-08).
 *
 * O ciclo tem duas fases de propósito. O **número** nasce dentro da transação do
 * pagamento, porque é o que a numeração sequencial exige (RN-21) e porque um recibo sem
 * número não é recibo. O **PDF** nasce depois, fora da transação: gerar um documento
 * envolve um Chromium e uma ida ao bucket, e nada disso pode segurar a transação que
 * está movendo dinheiro — nem derrubá-la se falhar.
 *
 * Daí `PENDING`: o pagamento entrou, o recibo existe e tem número, e o arquivo chega
 * quando chegar. O job de reprocesso cuida do resto.
 */

/**
 * RN-21 — número sequencial por tenant e ano.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` numa instrução só: dois pagamentos
 * simultâneos no mesmo balcão pegam números diferentes sem precisar de trava explícita,
 * porque o Postgres serializa a atualização da mesma linha.
 *
 * Uma `CREATE SEQUENCE` seria o caminho óbvio e não serve: sequence é global, e uma por
 * tenant exigiria DDL em tempo de execução.
 */
export async function allocateNumber(
  tx: TenantTransaction,
  tenantId: string,
  year: number,
): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO receipt_counters (tenant_id, year, last_number)
    VALUES (${tenantId}::uuid, ${year}, 1)
    ON CONFLICT (tenant_id, year) DO UPDATE
       SET last_number = receipt_counters.last_number + 1
    RETURNING last_number
  `

  const sequential = rows[0]?.last_number ?? 1
  return `${year}/${String(sequential).padStart(6, '0')}`
}

/**
 * Cria o recibo pendente. Roda **dentro** da transação do pagamento.
 *
 * O número é consumido aqui e não volta: recibo cancelado mantém o seu (RN-21), porque
 * um buraco na sequência é uma pergunta que o contador sabe responder e um número
 * reaproveitado é um documento duplicado que ele não sabe.
 */
export async function createPendingReceipt(
  tx: TenantTransaction,
  tenantId: string,
  input: { paymentId: string; tutorId: string; receivedAt: Date },
): Promise<{ id: string; number: string }> {
  const number = await allocateNumber(tx, tenantId, input.receivedAt.getUTCFullYear())

  const receipt = await tx.receipt.create({
    data: {
      tenantId,
      tutorId: input.tutorId,
      paymentId: input.paymentId,
      number,
    },
    select: { id: true, number: true },
  })

  return receipt
}

interface ReceiptRow {
  id: string
  number: string
  tutorId: string
  paymentId: string
  status: string
  storageKey: string | null
}

/**
 * Gera o PDF, arquiva e marca `ISSUED`.
 *
 * Idempotente: recibo já emitido volta como está. Falha de Gotenberg ou de bucket é
 * gravada em `last_error` e o recibo **continua pendente** — o job tenta de novo.
 * Lançar daqui derrubaria o `POST /v1/payments` por causa de um comprovante.
 */
export async function issueReceipt(
  actor: ActorContext,
  receiptId: string,
): Promise<{ status: string; issued: boolean }> {
  const data = await withTenant(actor.tenantId, async (tx) => {
    const receipt = await tx.receipt.findFirst({
      where: { id: receiptId },
      select: {
        id: true,
        number: true,
        tutorId: true,
        paymentId: true,
        status: true,
        storageKey: true,
      },
    })
    if (!receipt) throw notFound('Recibo não encontrado')
    if (receipt.status !== 'PENDING') return { receipt, payload: null }

    return { receipt, payload: await collectData(tx, actor.tenantId, receipt) }
  })

  if (!data.payload) return { status: data.receipt.status, issued: false }

  try {
    const pdf = await renderPdf(renderReceiptHtml(data.payload))
    const key = receiptKey(actor.tenantId, receiptId)
    await getStorage().put(key, pdf, 'application/pdf')

    await withTenant(
      actor.tenantId,
      async (tx) => {
        await tx.receipt.update({
          where: { id: receiptId },
          data: {
            status: 'ISSUED',
            storageKey: key,
            issuedAt: new Date(),
            lastError: null,
            attempts: { increment: 1 },
          },
        })
        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'ledger.receipt_issued',
          entity: 'receipt',
          entityId: receiptId,
          after: { number: data.receipt.number, paymentId: data.receipt.paymentId },
        })
      },
      tenantOptions(actor),
    )

    await publishEvent('recibo.emitido', {
      tenantId: actor.tenantId,
      receiptId,
      paymentId: data.receipt.paymentId,
      tutorId: data.receipt.tutorId,
      number: data.receipt.number,
    })
    recordMetric({
      metric: 'receipt_issued_total',
      tenantId: actor.tenantId,
      value: 1,
      unit: 'count',
    })

    return { status: 'ISSUED', issued: true }
  } catch (error) {
    const expected = error instanceof PdfUnavailableError || error instanceof StorageUnavailableError
    const message = error instanceof Error ? error.message : String(error)

    await withTenant(actor.tenantId, (tx) =>
      tx.receipt.update({
        where: { id: receiptId },
        data: { lastError: message.slice(0, 500), attempts: { increment: 1 } },
      }),
    ).catch(() => undefined)

    // Infra fora do ar é esperado e vira `warn`; o resto é bug e vira `error`.
    logger[expected ? 'warn' : 'error'](
      { err: error, receiptId, number: data.receipt.number },
      'recibo continua pendente',
    )
    return { status: 'PENDING', issued: false }
  }
}

/** Junta o que o papel mostra. Uma consulta por relação, dentro da mesma transação. */
async function collectData(tx: TenantTransaction, tenantId: string, receipt: ReceiptRow) {
  const payment = await tx.payment.findFirstOrThrow({
    where: { id: receipt.paymentId },
    include: {
      allocations: {
        where: { reversedAt: null },
        include: { debitEntry: { select: { description: true, occurredAt: true } } },
      },
      entry: { select: { balanceAfterCents: true } },
    },
  })

  const [tenant, tutor, settings] = await Promise.all([
    tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true } }),
    // RN-14 reserva o nome civil a documentos fiscais — e o RN-20 é explícito em que
    // este não é um. Quem tem nome social é chamado por ele no próprio comprovante.
    tx.tutor.findFirstOrThrow({
      where: { id: receipt.tutorId },
      select: { fullName: true, socialName: true },
    }),
    loadSettings(tx, tenantId),
  ])

  const allocations: ReceiptAllocationLine[] = payment.allocations.map((allocation) => ({
    description: allocation.debitEntry.description,
    amountCents: Number(allocation.amountCents),
    occurredAt: allocation.debitEntry.occurredAt,
  }))

  return {
    number: receipt.number,
    tenantName: tenant.name,
    tutorName: tutor.socialName ?? tutor.fullName,
    amountCents: Number(payment.amountCents),
    method: payment.method as PaymentMethod,
    receivedAt: payment.receivedAt,
    issuedAt: new Date(),
    allocations,
    creditCents: Number(payment.amountCents) - Number(payment.allocatedCents),
    balanceAfterCents: Number(payment.entry.balanceAfterCents),
    footerText: settings.receiptFooterText,
  }
}

/**
 * O pagamento foi revertido: o recibo vai a `CANCELLED` (§6).
 *
 * O arquivo **não é apagado** — a retenção contábil de 5 anos vale para ele também, e
 * um comprovante que some é exatamente o que a trilha existe para impedir. O que muda é
 * o status, e quem consultar vê que foi cancelado.
 */
export async function cancelReceipt(
  tx: TenantTransaction,
  tenantId: string,
  paymentId: string,
): Promise<void> {
  await tx.receipt.updateMany({
    where: { tenantId, paymentId, status: { in: ['PENDING', 'ISSUED', 'SENT'] } },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  })
}

export interface ReceiptView {
  id: string
  number: string
  status: string
  issuedAt: string | null
  /** Nula enquanto o PDF não existir — a tela mostra "em preparo" em vez de link morto. */
  url: string | null
}

/**
 * O recibo de um pagamento, pronto para a tela.
 *
 * Se ainda estiver pendente, **tenta emitir na hora**: quem clicou está esperando, e o
 * job de dez em dez minutos é a rede de segurança, não o caminho feliz.
 */
export async function getReceiptForPayment(
  actor: ActorContext,
  paymentId: string,
): Promise<ReceiptView> {
  let receipt = await loadByPayment(actor.tenantId, paymentId)

  if (receipt.status === 'PENDING' && isPdfConfigured()) {
    await issueReceipt(actor, receipt.id)
    receipt = await loadByPayment(actor.tenantId, paymentId)
  }

  let url: string | null = null
  if (receipt.storageKey) {
    try {
      url = await getStorage().signedUrl(receipt.storageKey, RECEIPT_URL_TTL_SECONDS)
    } catch (error) {
      // Recibo sem endereço ainda diz o número e o status — mais útil que um 502.
      logger.error({ err: error, receiptId: receipt.id }, 'falha ao assinar URL do recibo')
    }
  }

  return {
    id: receipt.id,
    number: receipt.number,
    status: receipt.status,
    issuedAt: receipt.issuedAt?.toISOString() ?? null,
    url,
  }
}

async function loadByPayment(tenantId: string, paymentId: string) {
  return withTenant(tenantId, async (tx) => {
    const receipt = await tx.receipt.findFirst({
      where: { paymentId },
      select: {
        id: true,
        number: true,
        status: true,
        storageKey: true,
        issuedAt: true,
      },
    })
    if (!receipt) throw notFound('Recibo não encontrado para este pagamento')
    return receipt
  })
}

interface PendingRow {
  id: string
  tenant_id: string
}

/** Quantas vezes insistir antes de deixar para o operador. */
const MAX_RECEIPT_ATTEMPTS = 10

/**
 * Job de reprocesso: os recibos que o Gotenberg não conseguiu gerar na hora.
 *
 * O teto de tentativas existe para um recibo cronicamente quebrado — HTML que derruba o
 * Chromium, bucket sem permissão — não consumir a janela do job para sempre. Passando
 * dele, `last_error` fica no banco à espera de alguém.
 */
export async function retryPendingReceipts(now: Date = new Date()): Promise<{ issued: number }> {
  const rows = await getMaintenancePrisma().$queryRaw<PendingRow[]>`
    SELECT id, tenant_id
      FROM receipts
     WHERE status = 'PENDING'
       AND attempts < ${MAX_RECEIPT_ATTEMPTS}
       AND created_at <= ${now}
     ORDER BY created_at ASC
     LIMIT 200
  `

  let issued = 0
  for (const row of rows) {
    try {
      const result = await issueReceipt({ tenantId: row.tenant_id }, row.id)
      if (result.issued) issued += 1
    } catch (error) {
      // Um recibo que não pôde ser emitido não derruba os outros 199.
      logger.error({ err: error, receiptId: row.id }, 'falha ao reprocessar recibo')
    }
  }

  return { issued }
}
