import { withTenant, type TenantTransaction } from '@petshop/db'
import type { CreatePaymentInput, ListPaymentsQuery } from '@petshop/shared-types'
import { PAYMENT_METHOD_LABELS, formatBRL } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { alreadyReversed, invalidAllocation, notFound } from './errors.js'
import { publishEvent } from '../../shared/events.js'
import { recordMetric } from '../../shared/logger.js'
import type { ActorContext } from './actor.js'
import { tenantOptions } from './actor.js'
import { getCashPort } from './cash-port.js'
import { lockAccount, openAccount, postEntry, type PostedEntry } from './accounts.js'
import {
  applyAllocations,
  lockDebit,
  lockOpenDebits,
  planFifo,
  unallocate,
  type AllocationPlanItem,
} from './allocation.js'
import { openCipher } from './crypto.js'
import { publishPosted } from './entries.js'
import { confirmIdempotency, hashPayload, reserveIdempotency } from './idempotency.js'
import { toPaymentResponse, type PaymentResponse } from './mapper.js'
import { cancelReceipt, createPendingReceipt, issueReceipt } from './receipts.js'
import { assertMethodEnabled, loadSettings } from './settings.js'

/**
 * Registro de pagamento (MOD-LEDGER-03).
 *
 * A v1 **não processa dinheiro**. O PIX cai na chave do petshop, a maquininha é do
 * petshop, e o que se registra aqui é o fato de o dinheiro ter entrado. Foi decisão
 * explícita: integrar gateway agora acrescentaria conciliação, webhooks idempotentes,
 * onboarding no PSP e superfície PCI a um módulo que ainda precisa acertar o básico.
 * `payments.external_ref` já está reservado para o `txid` do dia em que o gateway
 * entrar (RN-19), sem migração destrutiva.
 */

const ENDPOINT = 'POST /v1/payments'

/** O pagamento sem a idempotência da rota: é o que a venda "pago agora" também grava. */
export type PaymentWrite = Omit<CreatePaymentInput, 'idempotencyKey'>

export interface WrittenPayment {
  paymentId: string
  entry: PostedEntry
  manual: boolean
  receipt: { id: string }
}

export async function recordPayment(actor: ActorContext, input: CreatePaymentInput) {
  const requestHash = hashPayload(input as unknown as Record<string, unknown>)

  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const reservation = await reserveIdempotency(
        tx,
        actor.tenantId,
        ENDPOINT,
        input.idempotencyKey,
        requestHash,
      )
      if (reservation.existingResourceId) {
        return { repeated: true as const, paymentId: reservation.existingResourceId }
      }

      const written = await writePaymentInTx(tx, actor, input)
      await confirmIdempotency(tx, actor.tenantId, ENDPOINT, input.idempotencyKey, written.paymentId)
      return { repeated: false as const, ...written }
    },
    tenantOptions(actor),
  )

  if (!result.repeated) await announcePayment(actor, input, result)
  return { repeated: result.repeated, paymentId: result.paymentId }
}

/**
 * O registro do pagamento **na transação de quem chama**.
 *
 * Existe separado de `recordPayment` para a venda do balcão que o tutor paga na hora: o
 * débito da venda e o pagamento que o quita vingam juntos, como a baixa do estoque e o
 * débito já vingavam (RN-11 do MOD-ESTOQUE). A idempotência fica com quem chama — a
 * rota tem a dela, e a venda tem a sua.
 *
 * O que sai para fora (eventos, métrica, PDF do recibo) é de `announcePayment`, depois
 * do commit.
 */
export async function writePaymentInTx(
  tx: TenantTransaction,
  actor: ActorContext,
  input: PaymentWrite,
): Promise<WrittenPayment> {
  const settings = await loadSettings(tx, actor.tenantId)
  assertMethodEnabled(settings, input.method)

  const account = await openAccount(tx, actor.tenantId, input.tutorId)

  // O crédito entra primeiro; só depois se decide que débitos ele quita. A ordem
  // importa: `payments.entry_id` é NOT NULL, e o pagamento sem lançamento seria
  // dinheiro registrado fora do livro.
  const entry = await postEntry(tx, actor, account.balanceCents, {
    accountId: account.id,
    tutorId: input.tutorId,
    direction: 'CREDIT',
    amountCents: input.amountCents,
    category: 'PAYMENT',
    description: `Pagamento — ${PAYMENT_METHOD_LABELS[input.method]}`,
    sourceType: 'PAYMENT',
    occurredAt: new Date(input.receivedAt),
  })

  const cipher = input.notes || input.proofUrl ? await openCipher(tx, actor.tenantId) : null

  const payment = await tx.payment.create({
    data: {
      tenantId: actor.tenantId,
      accountId: account.id,
      tutorId: input.tutorId,
      amountCents: BigInt(input.amountCents),
      method: input.method,
      receivedAt: new Date(input.receivedAt),
      receivedBy: actor.actorUserId ?? null,
      entryId: entry.id,
      notesEncrypted: cipher && input.notes ? cipher.encrypt(input.notes) : null,
      proofUrlEncrypted: cipher && input.proofUrl ? cipher.encrypt(input.proofUrl) : null,
    },
    select: { id: true },
  })

  // O lançamento aponta de volta para o pagamento. Não dá para fazer isso na
  // criação — `payments.entry_id` é NOT NULL, então o lançamento nasce primeiro —
  // e `source_id` não está entre as colunas que o trigger de imutabilidade protege,
  // justamente por ser metadado de origem. O índice único
  // `(tenant, source_type, source_id, direction)` passa a valer também aqui.
  await tx.ledgerEntry.update({
    where: { id: entry.id },
    data: { sourceId: payment.id },
  })

  const manual = (input.allocations?.length ?? 0) > 0
  const plan = manual
    ? await planManual(tx, actor.tenantId, account.id, input.allocations ?? [])
    : planFifo(await lockOpenDebits(tx, actor.tenantId, account.id), input.amountCents)

  const allocated = await applyAllocations(
    tx,
    actor.tenantId,
    payment.id,
    plan.items,
    manual ? 'MANUAL' : 'AUTO_FIFO',
  )

  await tx.ledgerAccount.update({
    where: { id: account.id },
    data: { lastPaymentAt: new Date(input.receivedAt) },
  })

  // MOD-LEDGER-08: o número é alocado aqui, na transação — é o que a sequência do
  // RN-21 exige. O PDF vem depois, fora dela.
  const receipt = await createPendingReceipt(tx, actor.tenantId, {
    paymentId: payment.id,
    tutorId: input.tutorId,
    receivedAt: new Date(input.receivedAt),
  })

  // MOD-CAIXA: o dinheiro que entrou com o caixa aberto vai para a gaveta junto. Sem
  // caixa, ou no Starter, o pagamento é registrado do mesmo jeito.
  const inCash = await getCashPort().receivePayment(tx, actor, {
    paymentId: payment.id,
    method: input.method,
    amountCents: input.amountCents,
    receivedAt: new Date(input.receivedAt),
  })

  await recordAudit(tx, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId ?? null,
    action: 'ledger.payment_recorded',
    entity: 'payment',
    entityId: payment.id,
    after: {
      tutorId: input.tutorId,
      amountCents: input.amountCents,
      method: input.method,
      allocatedCents: allocated,
      leftoverCents: input.amountCents - allocated,
      balanceAfterCents: entry.balanceAfterCents,
      inCash,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  // §9: quitação manual fora do FIFO é o vetor clássico de desvio no balcão, e
  // por isso ganha a própria linha de trilha, com os débitos escolhidos.
  if (manual) {
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.actorUserId ?? null,
      action: 'ledger.allocation_manual',
      entity: 'payment',
      entityId: payment.id,
      after: { allocations: plan.items },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })
  }

  return { paymentId: payment.id, entry, manual, receipt }
}

/** O que sai depois do commit: eventos, métricas e o PDF do recibo. */
export async function announcePayment(
  actor: ActorContext,
  input: Pick<PaymentWrite, 'tutorId' | 'amountCents' | 'method' | 'receivedAt'>,
  result: WrittenPayment,
): Promise<void> {
  await publishPosted(actor, input.tutorId, result.entry)
  await publishEvent('pagamento.registrado', {
    tenantId: actor.tenantId,
    paymentId: result.paymentId,
    tutorId: input.tutorId,
    amountCents: input.amountCents,
    method: input.method,
    receivedAt: input.receivedAt,
    balanceCents: result.entry.balanceAfterCents,
  })

  recordMetric({
    metric: 'payment_recorded_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })
  if (result.manual) {
    recordMetric({
      metric: 'manual_allocation_total',
      tenantId: actor.tenantId,
      value: 1,
      unit: 'count',
    })
  }

  // O comprovante é gerado fora da transação e **não pode derrubar o pagamento**:
  // `issueReceipt` engole a falha e deixa o recibo pendente para o job de reprocesso.
  // O `await` fica porque no caminho feliz o recibo estará pronto quando a recepção
  // clicar nele — segundos depois, não minutos.
  await issueReceipt(actor, result.receipt.id)
}

/**
 * Alocação manual: o tutor quer pagar especificamente aquele débito.
 *
 * Cada débito é travado e conferido individualmente — alocar mais do que está aberto
 * estouraria o `chk_settled_bounds` do banco, e é melhor devolver 409 explicando qual
 * débito do que deixar o Postgres recusar com uma mensagem que ninguém no balcão sabe
 * ler.
 */
async function planManual(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  requested: { debitEntryId: string; amountCents: number }[],
): Promise<{ items: AllocationPlanItem[]; leftoverCents: number }> {
  const items: AllocationPlanItem[] = []

  for (const item of requested) {
    const debit = await lockDebit(tx, tenantId, accountId, item.debitEntryId)
    if (item.amountCents > debit.openCents) {
      throw invalidAllocation(
        `A alocação de ${formatBRL(item.amountCents)} excede o saldo aberto deste débito (${formatBRL(debit.openCents)})`,
        { debitEntryId: debit.id, openCents: debit.openCents },
      )
    }
    items.push({ debitEntryId: debit.id, amountCents: item.amountCents })
  }

  return { items, leftoverCents: 0 }
}

/**
 * AC-05 — o pagamento foi lançado no tutor errado e alguém percebeu 10 minutos depois.
 *
 * O pagamento vai a `REVERSED`, nasce a contrapartida (`DEBIT` de mesmo valor,
 * `category = PAYMENT_REVERSAL`), as alocações são desfeitas e os débitos voltam a
 * aberto. **Nada é apagado** — nem o pagamento, nem as alocações, que ficam marcadas
 * com `reversed_at`.
 *
 * RN-25: exclusivo de `TENANT_ADMIN` (a rota exige `finance:refund`).
 */
export async function reversePayment(actor: ActorContext, paymentId: string, reason: string) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id: paymentId },
        select: {
          id: true,
          tutorId: true,
          accountId: true,
          amountCents: true,
          method: true,
          status: true,
          entryId: true,
        },
      })
      if (!payment) throw notFound('Pagamento não encontrado')
      if (payment.status === 'REVERSED') {
        throw alreadyReversed('Este pagamento já foi revertido')
      }

      const account = await lockAccount(tx, actor.tenantId, payment.tutorId)

      // Primeiro as alocações: reabrir os débitos antes da contrapartida deixa o
      // estado consistente em qualquer ponto de falha da transação.
      await unallocate(tx, actor.tenantId, payment.id)

      const reversal = await postEntry(tx, actor, account.balanceCents, {
        accountId: payment.accountId,
        tutorId: payment.tutorId,
        direction: 'DEBIT',
        amountCents: Number(payment.amountCents),
        category: 'PAYMENT_REVERSAL',
        description: `Estorno de pagamento — ${PAYMENT_METHOD_LABELS[payment.method]}`,
        sourceType: 'SYSTEM',
        reversesEntryId: payment.entryId,
      })

      await tx.ledgerEntry.update({
        where: { id: payment.entryId },
        data: { status: 'REVERSED', reversedByEntryId: reversal.id },
      })

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'REVERSED', reversalReason: reason },
      })

      // §6: o recibo do pagamento revertido vai a CANCELLED. O arquivo continua no
      // bucket — retenção contábil vale para ele também.
      await cancelReceipt(tx, actor.tenantId, payment.id)

      // MOD-CAIXA: se o caixa em que o pagamento entrou ainda está aberto, o valor sai
      // dele. Fechado, o fechamento daquele dia não se mexe.
      await getCashPort().reversePayment(tx, actor, payment.id)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.payment_reversed',
        entity: 'payment',
        entityId: payment.id,
        before: { status: 'RECORDED', amountCents: Number(payment.amountCents) },
        after: { status: 'REVERSED', reason, reversalEntryId: reversal.id },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { tutorId: payment.tutorId, reversal }
    },
    tenantOptions(actor),
  )

  await publishPosted(actor, result.tutorId, result.reversal)
  await publishEvent('pagamento.estornado', {
    tenantId: actor.tenantId,
    paymentId,
    tutorId: result.tutorId,
    reason,
    reversedBy: actor.actorUserId ?? null,
    balanceCents: result.reversal.balanceAfterCents,
  })

  recordMetric({
    metric: 'payment_reversal_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return { paymentId, reversalEntryId: result.reversal.id }
}

/**
 * Detalhe do pagamento, com `notes` e `proofUrl` decifrados.
 *
 * O retorno é anotado (`PaymentResponse`) e não inferido: sem isso o TypeScript tenta
 * nomear o tipo gerado do Prisma pelo caminho dentro de `node_modules` e recusa emitir
 * (TS2742).
 */
export async function getPayment(
  actor: ActorContext,
  paymentId: string,
): Promise<PaymentResponse> {
  return withTenant(actor.tenantId, async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId },
      include: {
        allocations: { include: { debitEntry: { select: { description: true } } } },
      },
    })
    if (!payment) throw notFound('Pagamento não encontrado')

    const cipher = await openCipher(tx, actor.tenantId)
    return toPaymentResponse(payment, {
      notes: payment.notesEncrypted ? cipher.decrypt(payment.notesEncrypted) : null,
      proofUrl: payment.proofUrlEncrypted ? cipher.decrypt(payment.proofUrlEncrypted) : null,
    })
  })
}

export interface PaginatedPaymentsResponse {
  data: PaymentResponse[]
  total: number
  page: number
  limit: number
}

export async function listPayments(
  actor: ActorContext,
  query: ListPaymentsQuery,
): Promise<PaginatedPaymentsResponse> {
  return withTenant(actor.tenantId, async (tx) => {
    const where = {
      ...(query.tutorId ? { tutorId: query.tutorId } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.from || query.to
        ? {
            receivedAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    }

    const [rows, total] = await Promise.all([
      tx.payment.findMany({
        where,
        include: {
          allocations: { include: { debitEntry: { select: { description: true } } } },
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.payment.count({ where }),
    ])

    // A listagem **não** decifra `notes` nem `proofUrl`: campo livre com risco de PII
    // não vai na lista do dia, só no detalhe. Mesma regra que a agenda aplica a
    // `notes` do agendamento — e decifrar N linhas por página custaria uma operação
    // de cripto por pagamento para campos que a tela nem mostra.
    return {
      data: rows.map((row) => toPaymentResponse(row)),
      total,
      page: query.page,
      limit: query.limit,
    }
  })
}
