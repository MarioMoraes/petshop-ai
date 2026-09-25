import type { TenantTransaction } from '@petshop/db'
import type { CashMethod } from '@petshop/shared-types'
import { openAccount, postEntry, type PostedEntry } from '../ledger/accounts.js'
import { absorbLeftoverCredit } from '../ledger/allocation.js'
import {
  announceReversal,
  publishPosted,
  reverseEntryInTx,
  type ReversalResult,
} from '../ledger/entries.js'
import { announcePayment, writePaymentInTx, type WrittenPayment } from '../ledger/payments.js'
import { assertMethodEnabled, loadSettings } from '../ledger/settings.js'
import type { ActorContext } from './actor.js'

/**
 * A porta do MOD-ESTOQUE para o MOD-LEDGER — o que a venda do balcão pode fazer na conta
 * corrente do tutor, e nada mais.
 *
 * **Tudo roda na transação de quem chama** (RN-11): a baixa do estoque e o débito
 * `PRODUCT` vingam juntos ou não vingam. `createManualEntry` abriria a sua própria
 * transação, e uma falha entre as duas deixaria a ração fora da prateleira sem ninguém
 * devendo por ela. Os eventos do razão saem depois do commit, pelos dois `announce*`.
 *
 * A lista é curta de propósito: débito de venda, estorno dele, a leitura do limite e —
 * desde o MOD-CAIXA — o pagamento **da própria venda** quando o tutor paga na hora. O
 * estoque não lança crédito solto, não paga dívida antiga e não mexe em pacote.
 */

export interface CreditStatus {
  /** Negativo é dívida (RN-02 do MOD-LEDGER). */
  balanceCents: number
  /** Nulo é "sem limite", e nulo nunca bloqueia (AC-03 de MOD-LEDGER-09). */
  creditLimitCents: number | null
}

export interface SaleDebitInput {
  tutorId: string
  saleId: string
  amountCents: number
  /** O texto que o tutor lê no extrato. */
  description: string
}

export interface InventoryLedgerPort {
  creditStatus(tx: TenantTransaction, tenantId: string, tutorId: string): Promise<CreditStatus>
  postSaleDebit(
    tx: TenantTransaction,
    actor: ActorContext,
    input: SaleDebitInput,
  ): Promise<PostedEntry>
  /**
   * Estorna o débito da venda. `null` quando ele já tinha sido estornado pela tela do
   * financeiro: o dinheiro já voltou, e o que falta à venda é só devolver ao estoque.
   */
  reverseSaleDebit(
    tx: TenantTransaction,
    actor: ActorContext,
    entryId: string,
    reason: string,
  ): Promise<ReversalResult | null>
  /**
   * MOD-CAIXA: o tutor pagou na hora. O pagamento quita **este** débito, e não o mais
   * antigo pelo FIFO: quem pagou a ração no balcão pagou a ração. Paga só o que ficou em
   * aberto depois do crédito solto que o débito já absorveu; `null` se não sobrou nada.
   */
  postSalePayment(
    tx: TenantTransaction,
    actor: ActorContext,
    input: { tutorId: string; debitEntryId: string; method: CashMethod },
  ): Promise<{ written: WrittenPayment; amountCents: number; receivedAt: string } | null>
  /** A forma de pagamento está ligada nas políticas de cobrança do estabelecimento? */
  assertMethodEnabled(tx: TenantTransaction, tenantId: string, method: CashMethod): Promise<void>
  announceDebit(actor: ActorContext, tutorId: string, entry: PostedEntry): Promise<void>
  announcePayment(
    actor: ActorContext,
    input: { tutorId: string; amountCents: number; method: CashMethod; receivedAt: string },
    written: WrittenPayment,
  ): Promise<void>
  announceReversal(
    actor: ActorContext,
    entryId: string,
    result: ReversalResult,
    reason: string,
  ): Promise<void>
}

function createInProcessPort(): InventoryLedgerPort {
  return {
    async creditStatus(tx, tenantId, tutorId) {
      const [account, settings] = await Promise.all([
        tx.ledgerAccount.findFirst({ where: { tutorId }, select: { balanceCents: true } }),
        tx.billingSettings.findFirst({ where: { tenantId }, select: { creditLimitCents: true } }),
      ])
      return {
        balanceCents: Number(account?.balanceCents ?? 0),
        creditLimitCents:
          settings?.creditLimitCents === null || settings?.creditLimitCents === undefined
            ? null
            : Number(settings.creditLimitCents),
      }
    },

    async postSaleDebit(tx, actor, input) {
      const account = await openAccount(tx, actor.tenantId, input.tutorId)
      const entry = await postEntry(tx, actor, account.balanceCents, {
        accountId: account.id,
        tutorId: input.tutorId,
        direction: 'DEBIT',
        amountCents: input.amountCents,
        category: 'PRODUCT',
        description: input.description,
        sourceType: 'PRODUCT_SALE',
        sourceId: input.saleId,
      })
      // RN-07 do MOD-LEDGER: crédito solto de um pagamento anterior quita a compra agora,
      // como quita qualquer outro débito.
      await absorbLeftoverCredit(tx, actor.tenantId, account.id, entry.id, input.amountCents)
      return entry
    },

    async reverseSaleDebit(tx, actor, entryId, reason) {
      const entry = await tx.ledgerEntry.findFirst({
        where: { id: entryId },
        select: { status: true },
      })
      if (!entry || entry.status === 'REVERSED') return null
      return reverseEntryInTx(tx, actor, entryId, reason)
    },

    async postSalePayment(tx, actor, input) {
      const debit = await tx.ledgerEntry.findFirst({
        where: { id: input.debitEntryId },
        select: { amountCents: true, settledCents: true },
      })
      const open = debit ? Number(debit.amountCents - debit.settledCents) : 0
      if (open <= 0) return null

      const receivedAt = new Date().toISOString()
      const written = await writePaymentInTx(tx, actor, {
        tutorId: input.tutorId,
        amountCents: open,
        method: input.method,
        receivedAt,
        allocations: [{ debitEntryId: input.debitEntryId, amountCents: open }],
      })
      return { written, amountCents: open, receivedAt }
    },

    async assertMethodEnabled(tx, tenantId, method) {
      assertMethodEnabled(await loadSettings(tx, tenantId), method)
    },

    announceDebit: publishPosted,
    announcePayment,
    announceReversal,
  }
}

let port: InventoryLedgerPort | null = null

export function getLedgerPort(): InventoryLedgerPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setLedgerPort(next: InventoryLedgerPort | null): void {
  port = next
}
