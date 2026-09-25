import type { TenantTransaction } from '@petshop/db'
import { isCashMethod, type PaymentMethod } from '@petshop/shared-types'
import { tenantHasFeature } from '../../shared/plan.js'
import {
  findMovementBySource,
  lockOpenSession,
  lockSessionIfOpen,
  postCashMovement,
} from '../cash/register.js'
import type { ActorContext } from './actor.js'

/**
 * A porta do MOD-LEDGER para o MOD-CAIXA — o que o pagamento do tutor faz na gaveta.
 *
 * **O pagamento nunca depende do caixa** (decisão do PRD caixa_17): o PIX de ontem
 * lançado hoje, ou o pagamento do Starter, que não tem caixa, continuam sendo
 * registrados. O caixa só recebe o pagamento quando há um aberto, o plano o inclui, e o
 * dinheiro entrou **depois** da abertura — o pagamento com data anterior não estava na
 * gaveta que está aberta agora.
 *
 * Roda na transação do pagamento: gravado o pagamento, o movimento do caixa vai junto.
 */
export interface LedgerCashPort {
  /** Põe o pagamento no caixa aberto, se houver. Devolve se pôs. */
  receivePayment(
    tx: TenantTransaction,
    actor: ActorContext,
    input: { paymentId: string; method: PaymentMethod; amountCents: number; receivedAt: Date },
  ): Promise<boolean>
  /**
   * O estorno do pagamento tira o valor do caixa **onde ele entrou**, se esse caixa
   * ainda estiver aberto. Fechado, o fechamento é história: a correção de um dia
   * encerrado não reabre a contagem dele.
   */
  reversePayment(tx: TenantTransaction, actor: ActorContext, paymentId: string): Promise<boolean>
}

function createInProcessPort(): LedgerCashPort {
  return {
    async receivePayment(tx, actor, input) {
      if (!isCashMethod(input.method)) return false
      if (!(await tenantHasFeature(actor.tenantId, 'CASH_REGISTER'))) return false

      const session = await lockOpenSession(tx)
      if (!session) return false
      const opened = await tx.cashSession.findFirst({
        where: { id: session.id },
        select: { openedAt: true },
      })
      if (!opened || input.receivedAt < opened.openedAt) return false

      await postCashMovement(tx, actor, {
        sessionId: session.id,
        type: 'TUTOR_PAYMENT',
        method: input.method,
        amountCents: input.amountCents,
        sourceType: 'PAYMENT',
        sourceId: input.paymentId,
      })
      return true
    },

    async reversePayment(tx, actor, paymentId) {
      const received = await findMovementBySource(tx, 'TUTOR_PAYMENT', paymentId)
      if (!received) return false
      const session = await lockSessionIfOpen(tx, received.sessionId)
      if (!session) return false

      await postCashMovement(tx, actor, {
        sessionId: session.id,
        type: 'PAYMENT_REVERSAL',
        method: received.method,
        amountCents: -Number(received.amountCents),
        sourceType: 'PAYMENT',
        sourceId: paymentId,
      })
      return true
    },
  }
}

let port: LedgerCashPort | null = null

export function getCashPort(): LedgerCashPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setCashPort(next: LedgerCashPort | null): void {
  port = next
}
