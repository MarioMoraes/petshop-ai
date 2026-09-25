import type { TenantTransaction } from '@petshop/db'
import type { CashMethod } from '@petshop/shared-types'
import { noOpenSession } from '../cash/errors.js'
import { lockOpenSession, postCashMovement } from '../cash/register.js'
import type { ActorContext } from './actor.js'

/**
 * A porta do MOD-ESTOQUE para o MOD-CAIXA — o dinheiro da venda avulsa.
 *
 * **A venda avulsa exige caixa aberto** (decisão do PRD caixa_17): sem tutor, não há
 * conta onde o valor possa esperar, e a gaveta é o único lugar onde ele existe. Sem
 * caixa, a venda inteira é recusada, e o estoque não sai.
 *
 * A venda para tutor que paga na hora **não** passa por aqui: o pagamento é do razão, e
 * é o razão que o põe no caixa (`ledger/cash-port.ts`).
 *
 * Tudo roda na transação da venda.
 */
export interface InventoryCashPort {
  /** Põe a venda no caixa aberto e devolve a sessão. Sem caixa, `ERR_CASH_004`. */
  receiveWalkInSale(
    tx: TenantTransaction,
    actor: ActorContext,
    input: { saleId: string; method: CashMethod; amountCents: number; description: string },
  ): Promise<{ sessionId: string }>
  /**
   * O estorno devolve o dinheiro **do caixa aberto agora**, e não do caixa da venda: é
   * da gaveta de hoje que a nota sai para a mão do cliente, mesmo que ele tenha comprado
   * ontem.
   */
  refundWalkInSale(
    tx: TenantTransaction,
    actor: ActorContext,
    input: { saleId: string; method: CashMethod; amountCents: number; description: string },
  ): Promise<{ sessionId: string }>
}

function createInProcessPort(): InventoryCashPort {
  return {
    async receiveWalkInSale(tx, actor, input) {
      const session = await lockOpenSession(tx)
      if (!session) {
        throw noOpenSession('Nenhum caixa aberto. Abra o caixa do dia para vender sem tutor.')
      }
      await postCashMovement(tx, actor, {
        sessionId: session.id,
        type: 'WALK_IN_SALE',
        method: input.method,
        amountCents: input.amountCents,
        sourceType: 'PRODUCT_SALE',
        sourceId: input.saleId,
        reason: input.description,
      })
      return { sessionId: session.id }
    },

    async refundWalkInSale(tx, actor, input) {
      const session = await lockOpenSession(tx)
      if (!session) {
        throw noOpenSession(
          'Nenhum caixa aberto. Abra o caixa do dia para devolver o dinheiro da venda.',
        )
      }
      await postCashMovement(tx, actor, {
        sessionId: session.id,
        type: 'SALE_REFUND',
        method: input.method,
        amountCents: -input.amountCents,
        sourceType: 'PRODUCT_SALE',
        sourceId: input.saleId,
        reason: input.description,
      })
      return { sessionId: session.id }
    },
  }
}

let port: InventoryCashPort | null = null

export function getCashPort(): InventoryCashPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setCashPort(next: InventoryCashPort | null): void {
  port = next
}
