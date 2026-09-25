import type { TenantTransaction } from '@petshop/db'
import { openAccount, postEntry, type PostedEntry } from '../ledger/accounts.js'
import { absorbLeftoverCredit } from '../ledger/allocation.js'
import {
  announceReversal,
  publishPosted,
  reverseEntryInTx,
  type ReversalResult,
} from '../ledger/entries.js'
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
 * A lista é curta de propósito: débito de venda, estorno dele e a leitura do limite. O
 * estoque não lança crédito, não registra pagamento e não mexe em pacote.
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
  announceDebit(actor: ActorContext, tutorId: string, entry: PostedEntry): Promise<void>
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

    announceDebit: publishPosted,
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
