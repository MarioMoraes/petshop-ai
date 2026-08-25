'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type {
  EntryDirection,
  ManualEntryCategory,
  PackagePurchase,
  Payment,
  PaymentMethod,
  Receipt,
  Statement,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações da conta corrente (MOD-LEDGER).
 *
 * **A chave de idempotência nasce aqui, no servidor, e nunca no cliente.** O balcão
 * é o lugar em que o duplo clique acontece de verdade — com o tutor esperando e o
 * atendente com o pet na coleira — e é esta chave que impede o pagamento de ser
 * lançado duas vezes. Gerá-la no browser não resolveria: o React reenviaria a mesma
 * ação com um `useState` novo depois de um refresh.
 */

export interface LedgerActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /** ERR_LEDGER_003: a UI mostra quais formas o estabelecimento aceita. */
  enabledPaymentMethods?: PaymentMethod[]
}

export type ActionResult<T> = { ok: true; data: T } | LedgerActionFailure

function toFailure(error: unknown): LedgerActionFailure {
  if (error instanceof ApiError) {
    const problem = error.problem as Record<string, unknown> | null
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(problem?.enabledPaymentMethods
        ? { enabledPaymentMethods: problem.enabledPaymentMethods as PaymentMethod[] }
        : {}),
    }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

/** Revalida a ficha do tutor e a listagem, que mostra o saldo denormalizado. */
function revalidateTutor(tutorId: string): void {
  revalidatePath(`/tutores/${tutorId}`)
  revalidatePath('/tutores')
}

export async function loadStatementAction(
  tutorId: string,
  query: { from?: string; to?: string; page?: number } = {},
): Promise<ActionResult<Statement>> {
  try {
    return { ok: true, data: await serverApi().getStatement(tutorId, { ...query, limit: 20 }) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function registerPaymentAction(input: {
  tutorId: string
  amountCents: number
  method: PaymentMethod
  receivedAt: string
  notes?: string
}): Promise<ActionResult<Payment>> {
  try {
    const payment = await serverApi().createPayment({
      ...input,
      idempotencyKey: randomUUID(),
    })
    revalidateTutor(input.tutorId)
    return { ok: true, data: payment }
  } catch (error) {
    return toFailure(error)
  }
}

export async function createEntryAction(input: {
  tutorId: string
  direction: EntryDirection
  amountCents: number
  category: ManualEntryCategory
  description: string
  internalNotes?: string
}): Promise<ActionResult<{ id: string }>> {
  try {
    const entry = await serverApi().createLedgerEntry({
      ...input,
      idempotencyKey: randomUUID(),
    })
    revalidateTutor(input.tutorId)
    return { ok: true, data: { id: entry.id } }
  } catch (error) {
    return toFailure(error)
  }
}

export async function reverseEntryAction(
  tutorId: string,
  entryId: string,
  reason: string,
): Promise<ActionResult<{ reversalEntryId: string }>> {
  try {
    const result = await serverApi().reverseLedgerEntry(entryId, { reason })
    revalidateTutor(tutorId)
    return { ok: true, data: { reversalEntryId: result.reversalEntryId } }
  } catch (error) {
    return toFailure(error)
  }
}

export async function sellPackageAction(input: {
  tutorId: string
  packageId: string
  petId?: string
  paymentMethod: PaymentMethod
}): Promise<ActionResult<PackagePurchase>> {
  try {
    const purchase = await serverApi().purchasePackage(input.packageId, {
      tutorId: input.tutorId,
      ...(input.petId ? { petId: input.petId } : {}),
      paymentMethod: input.paymentMethod,
      idempotencyKey: randomUUID(),
    })
    revalidateTutor(input.tutorId)
    return { ok: true, data: purchase }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updatePurchaseAction(
  tutorId: string,
  purchaseId: string,
  input: { petId?: string; status?: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'; reason?: string },
): Promise<ActionResult<PackagePurchase>> {
  try {
    const purchase = await serverApi().updatePackagePurchase(purchaseId, input)
    revalidateTutor(tutorId)
    return { ok: true, data: purchase }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * O recibo de um pagamento (MOD-LEDGER-08).
 *
 * A chamada tenta emitir do lado do servidor quando o recibo ainda está pendente —
 * quem clicou está esperando, e o job de dez em dez minutos é a rede de segurança, não
 * o caminho feliz.
 */
export async function loadReceiptAction(paymentId: string): Promise<ActionResult<Receipt>> {
  try {
    return { ok: true, data: await serverApi().getReceipt(paymentId) }
  } catch (error) {
    return toFailure(error)
  }
}
