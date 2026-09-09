import type { TenantTransaction } from '@petshop/db'
import { invalidAllocation } from './errors.js'

/**
 * Alocação pagamento↔débito (MOD-LEDGER-04).
 *
 * RN-06: **FIFO por padrão** — o pagamento quita os débitos mais antigos primeiro.
 * Alocação manual existe (o tutor quer pagar especificamente a consulta de ontem),
 * mas é auditada, porque quitação fora do FIFO é o vetor clássico de desvio no balcão:
 * o débito antigo fica aberto para sempre enquanto os novos vão sendo quitados, e a
 * dívida some do radar sem nunca ter sido paga.
 */

interface OpenDebitRow {
  id: string
  amount_cents: bigint
  settled_cents: bigint
  description: string
  occurred_at: Date
}

export interface OpenDebit {
  id: string
  amountCents: number
  settledCents: number
  openCents: number
  description: string
  occurredAt: Date
}

/**
 * Débitos abertos da conta, mais antigos primeiro, travados para escrita.
 *
 * A ordem é por `occurred_at` — a data do fato, não a do registro. Um serviço de
 * semana passada lançado hoje é mais antigo que o de ontem lançado ontem, e o FIFO
 * que ignorasse isso quitaria na ordem errada.
 */
export async function lockOpenDebits(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
): Promise<OpenDebit[]> {
  const rows = await tx.$queryRaw<OpenDebitRow[]>`
    SELECT id, amount_cents, settled_cents, description, occurred_at
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND direction = 'DEBIT'
       AND status = 'POSTED'
       AND settled_cents < amount_cents
     ORDER BY occurred_at ASC, id ASC
     FOR UPDATE
  `
  return rows.map(toOpenDebit)
}

/** Um débito específico, para a alocação manual. */
export async function lockDebit(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  entryId: string,
): Promise<OpenDebit> {
  const rows = await tx.$queryRaw<OpenDebitRow[]>`
    SELECT id, amount_cents, settled_cents, description, occurred_at
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND id = ${entryId}::uuid
       AND direction = 'DEBIT'
       AND status = 'POSTED'
     FOR UPDATE
  `
  const row = rows[0]
  if (!row) {
    throw invalidAllocation('Débito não encontrado nesta conta ou já estornado', {
      debitEntryId: entryId,
    })
  }

  const debit = toOpenDebit(row)
  if (debit.openCents <= 0) {
    throw invalidAllocation('Este débito já está quitado', { debitEntryId: entryId })
  }
  return debit
}

function toOpenDebit(row: OpenDebitRow): OpenDebit {
  const amountCents = Number(row.amount_cents)
  const settledCents = Number(row.settled_cents)
  return {
    id: row.id,
    amountCents,
    settledCents,
    openCents: amountCents - settledCents,
    description: row.description,
    occurredAt: row.occurred_at,
  }
}

export interface AllocationPlanItem {
  debitEntryId: string
  amountCents: number
}

/**
 * Distribui um valor pelos débitos abertos, do mais antigo ao mais novo.
 *
 * Função pura, e é aqui que os três cenários do AC do MOD-LEDGER-03 se resolvem:
 * pagamento exato zera tudo; pagamento parcial quita os primeiros e deixa o último
 * `PARTIALLY_SETTLED`; pagamento maior que a dívida aloca tudo o que dá e devolve o
 * resto em `leftoverCents`, que vira crédito na conta (RN-07 — o sistema não devolve
 * dinheiro).
 */
export function planFifo(
  debits: OpenDebit[],
  amountCents: number,
): { items: AllocationPlanItem[]; leftoverCents: number } {
  const items: AllocationPlanItem[] = []
  let remaining = amountCents

  for (const debit of debits) {
    if (remaining <= 0) break
    const allocated = Math.min(remaining, debit.openCents)
    if (allocated <= 0) continue
    items.push({ debitEntryId: debit.id, amountCents: allocated })
    remaining -= allocated
  }

  return { items, leftoverCents: remaining }
}

/**
 * Grava o plano: uma linha em `payment_allocations` por débito tocado, e o
 * `settled_cents` do débito avançando.
 *
 * `settled_cents` é a única coluna de `ledger_entries` que o trigger de imutabilidade
 * deixa crescer — junto dos metadados de estorno. O lançamento continua imutável no
 * que importa: valor, direção, conta, datas e saldo corrido.
 */
export async function applyAllocations(
  tx: TenantTransaction,
  tenantId: string,
  paymentId: string,
  items: AllocationPlanItem[],
  allocatedBy: 'AUTO_FIFO' | 'MANUAL',
): Promise<number> {
  let total = 0

  for (const item of items) {
    await tx.paymentAllocation.create({
      data: {
        tenantId,
        paymentId,
        debitEntryId: item.debitEntryId,
        amountCents: BigInt(item.amountCents),
        allocatedBy,
      },
    })
    await tx.ledgerEntry.update({
      where: { id: item.debitEntryId },
      data: { settledCents: { increment: BigInt(item.amountCents) } },
    })
    total += item.amountCents
  }

  if (total > 0) {
    await tx.payment.update({
      where: { id: paymentId },
      data: { allocatedCents: { increment: BigInt(total) } },
    })
  }

  return total
}

/**
 * Desfaz as alocações de um pagamento revertido (AC-05 de MOD-LEDGER-03).
 *
 * **Marca, não apaga.** O AC é explícito em que nada desaparece do rastro: a linha
 * fica com `reversed_at`, e o `settled_cents` do débito volta atrás — reabrindo-o,
 * que é o efeito visível para quem olha o extrato.
 */
export async function unallocate(
  tx: TenantTransaction,
  tenantId: string,
  paymentId: string,
): Promise<void> {
  const allocations = await tx.paymentAllocation.findMany({
    where: { tenantId, paymentId, reversedAt: null },
    select: { id: true, debitEntryId: true, amountCents: true },
  })

  const now = new Date()
  for (const allocation of allocations) {
    await tx.ledgerEntry.update({
      where: { id: allocation.debitEntryId },
      data: { settledCents: { decrement: allocation.amountCents } },
    })
    await tx.paymentAllocation.update({
      where: { id: allocation.id },
      data: { reversedAt: now },
    })
  }

  await tx.payment.update({
    where: { id: paymentId },
    data: { allocatedCents: 0 },
  })
}

interface UnallocatedPaymentRow {
  id: string
  amount_cents: bigint
  allocated_cents: bigint
}

/**
 * RN-07 — o crédito que sobrou de um pagamento anterior quita o débito novo.
 *
 * Sem isto o saldo diria `+100` e o débito de R$ 100 apareceria como aberto no mesmo
 * extrato: o cliente vê "você tem crédito" e "você deve", ao mesmo tempo, pelo mesmo
 * dinheiro. A invariante que se preserva é `soma dos débitos abertos == -saldo`, e é
 * dela que o job de reconciliação e o resumo da conta dependem.
 */
export async function absorbLeftoverCredit(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  debitEntryId: string,
  debitAmountCents: number,
): Promise<number> {
  const rows = await tx.$queryRaw<UnallocatedPaymentRow[]>`
    SELECT id, amount_cents, allocated_cents
      FROM payments
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND status = 'RECORDED'
       AND allocated_cents < amount_cents
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  `

  let remaining = debitAmountCents
  let absorbed = 0

  for (const row of rows) {
    if (remaining <= 0) break
    const available = Number(row.amount_cents) - Number(row.allocated_cents)
    if (available <= 0) continue

    const amount = Math.min(remaining, available)
    await applyAllocations(tx, tenantId, row.id, [{ debitEntryId, amountCents: amount }], 'AUTO_FIFO')
    remaining -= amount
    absorbed += amount
  }

  return absorbed
}
