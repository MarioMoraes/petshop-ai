import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  cancelDocument,
  createPendingDocument,
  issueDocument,
  loadIssuer,
} from '@petshop/documents'
import { DOCUMENT_MAX_ATTEMPTS, formatBRL, type PaymentMethod } from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { logger, recordMetric } from '../../lib/logger.js'
import { isPdfConfigured, renderPdf } from '../../lib/pdf.js'
import { RECEIPT_URL_TTL_SECONDS, documentStorage, getStorage } from '../../lib/storage.js'
import type { ActorContext } from './actor.js'
import { tenantOptions } from './actor.js'
import { RECEIPT_TITLE, renderReceiptHtml, type ReceiptAllocationLine } from './receipt-template.js'
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
 * Cria o recibo pendente. Roda **dentro** da transação do pagamento.
 *
 * O número é consumido aqui e não volta: recibo cancelado mantém o seu (RN-04 do
 * MOD-DOC), porque um buraco na sequência é uma pergunta que o contador sabe responder e
 * um número reaproveitado é um documento duplicado que ele não sabe.
 *
 * Desde a fatia 1 do MOD-DOC nascem **duas** linhas: o `document`, que é o dono do
 * arquivo e da série, e o `receipt`, que guarda o que só o recibo tem — o vínculo com o
 * pagamento e o estado `SENT`, que o documento não conhece porque entrega é fato da
 * mensagem.
 */
export async function createPendingReceipt(
  tx: TenantTransaction,
  tenantId: string,
  input: { paymentId: string; tutorId: string; receivedAt: Date },
): Promise<{ id: string; number: string }> {
  const document = await createPendingDocument(tx, tenantId, {
    kind: 'RECEIPT',
    tutorId: input.tutorId,
    // O ano da série é o do **fato**, não o de agora: pagamento lançado em 2 de janeiro
    // com data de 31 de dezembro é recibo do ano que fechou.
    reference: input.receivedAt,
  })

  const receipt = await tx.receipt.create({
    data: {
      tenantId,
      tutorId: input.tutorId,
      paymentId: input.paymentId,
      number: document.number,
      documentId: document.id,
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
  documentId: string | null
}

/**
 * Gera o PDF, arquiva e marca `ISSUED`.
 *
 * Idempotente: recibo já emitido volta como está. Falha de Gotenberg ou de bucket fica
 * em `documents.last_error` e o recibo **continua pendente** — o job tenta de novo.
 * Lançar daqui derrubaria o `POST /v1/payments` por causa de um comprovante.
 *
 * A mecânica de renderizar, arquivar e marcar mora em `@petshop/documents` desde a
 * fatia 1 do MOD-DOC; o que fica aqui é o que só o ledger sabe — o que o papel mostra.
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
        documentId: true,
      },
    })
    if (!receipt) throw notFound('Recibo não encontrado')
    if (receipt.status !== 'PENDING') return { receipt, payload: null }

    return { receipt, payload: await collectData(tx, actor.tenantId, receipt) }
  })

  if (!data.payload) return { status: data.receipt.status, issued: false }

  // Recibo criado antes do MOD-DOC não tem documento: o backfill da migration só
  // alcançou os que tinham tenant vivo. Sem ele não há onde arquivar, e insistir a cada
  // dez minutos seria ruído — o recibo fica como está.
  const documentId = data.receipt.documentId
  if (!documentId) {
    logger.warn({ receiptId, number: data.receipt.number }, 'recibo sem documento associado')
    return { status: data.receipt.status, issued: false }
  }

  const outcome = await issueDocument(
    {
      renderPdf,
      storage: documentStorage,
      logger,
      tenantOptions: tenantOptions(actor),
    },
    {
      tenantId: actor.tenantId,
      documentId,
      kind: 'RECEIPT',
      html: renderReceiptHtml(data.payload),
      title: RECEIPT_TITLE,
      number: data.receipt.number,
    },
  )

  // `issued` é falso também quando o arquivo **já existia** — o processo morreu entre
  // arquivar e atualizar o recibo. O que decide daqui para baixo é o estado do
  // documento, não o de quem acabou de renderizar.
  if (outcome.status !== 'ISSUED') return { status: outcome.status, issued: false }

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await tx.receipt.update({
        where: { id: receiptId },
        data: { status: 'ISSUED', issuedAt: new Date(), lastError: null },
      })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.receipt_issued',
        entity: 'receipt',
        entityId: receiptId,
        // `documentNumber`, e não `number`: `number` está na lista de chaves sensíveis
        // do `service-kit` (é o número do endereço), e a trilha vinha gravando
        // `[redacted]` no lugar da série do recibo desde o MOD-LEDGER. O §9 do MOD-DOC
        // exige o número na trilha, e uma trilha de emissão sem ele não responde nada.
        after: { documentNumber: data.receipt.number, paymentId: data.receipt.paymentId },
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
    /**
     * MOD-NOTIF-06: quem entrega o recibo por e-mail precisa do documento para anexá-lo.
     *
     * Vai daqui porque o publicador já o tem na mão — resolvê-lo do `receiptId` do outro
     * lado obrigaria o consumidor a ler uma tabela do financeiro. O valor viaja junto e
     * **já formatado**: o template não faz conta, e um número em centavos escapando para
     * o corpo de uma mensagem é o erro mais caro que este catálogo pode cometer.
     */
    documentId,
    amount: formatBRL(data.payload.amountCents),
  })
  recordMetric({
    metric: 'receipt_issued_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return { status: 'ISSUED', issued: true }
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

  const [emissor, tutor, billing] = await Promise.all([
    // O cabeçalho de quem emitiu mora em `@petshop/documents` desde a fatia 2 do
    // MOD-DOC: o receituário foi o segundo a precisar dele, e montá-lo é igual nos dois.
    loadIssuer(tx, tenantId),
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
    issuer: emissor.issuer,
    timezone: emissor.timezone,
    tutorName: tutor.socialName ?? tutor.fullName,
    amountCents: Number(payment.amountCents),
    method: payment.method as PaymentMethod,
    receivedAt: payment.receivedAt,
    issuedAt: new Date(),
    allocations,
    creditCents: Number(payment.amountCents) - Number(payment.allocatedCents),
    balanceAfterCents: Number(payment.entry.balanceAfterCents),
    footerText: billing.receiptFooterText,
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
  const alvos = await tx.receipt.findMany({
    where: { tenantId, paymentId, status: { in: ['PENDING', 'ISSUED', 'SENT'] } },
    select: { id: true, documentId: true },
  })
  if (alvos.length === 0) return

  await tx.receipt.updateMany({
    where: { id: { in: alvos.map((alvo) => alvo.id) } },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  })

  for (const alvo of alvos) {
    if (alvo.documentId) await cancelDocument(tx, alvo.documentId)
  }
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

  const storageKey = receipt.document?.storageKey ?? receipt.storageKey
  let url: string | null = null
  if (storageKey) {
    try {
      url = await getStorage().signedUrl(storageKey, RECEIPT_URL_TTL_SECONDS)
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
        issuedAt: true,
        // A coluna do recibo é leitura de reserva: para de ser escrita nesta fatia e
        // cobre os recibos anteriores ao backfill, que não têm documento (MOD-DOC-02).
        storageKey: true,
        document: { select: { storageKey: true } },
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

/**
 * Job de reprocesso: os recibos que o Gotenberg não conseguiu gerar na hora.
 *
 * A varredura junta as duas tabelas de propósito. `attempts` e `last_error` moram no
 * **documento** desde a fatia 1 do MOD-DOC, e é dele que sai o orçamento de tentativas;
 * mas o que precisa ficar em pé é o **recibo**, e ele pode estar pendente com o documento
 * já emitido — o processo morreu entre arquivar e atualizar. Varrer só documentos
 * pendentes deixaria esse recibo pendurado para sempre.
 *
 * O teto de tentativas existe para um documento cronicamente quebrado — HTML que derruba
 * o Chromium, bucket sem permissão — não consumir a janela do job para sempre. Passando
 * dele, o documento vai a `FAILED` e `last_error` fica à espera de alguém.
 */
export async function retryPendingReceipts(now: Date = new Date()): Promise<{ issued: number }> {
  const rows = await getMaintenancePrisma().$queryRaw<PendingRow[]>`
    SELECT r.id, r.tenant_id
      FROM receipts r
      JOIN documents d ON d.id = r.document_id
     WHERE r.status = 'PENDING'
       AND d.status IN ('PENDING', 'ISSUED')
       AND d.attempts < ${DOCUMENT_MAX_ATTEMPTS}
       AND r.created_at <= ${now}
     ORDER BY r.created_at ASC
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
