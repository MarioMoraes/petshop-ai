import type { TenantTransaction } from '@petshop/db'
import type { CashMethod, CashMovementType } from '@petshop/shared-types'
import type { ActorContext } from './actor.js'

/**
 * O núcleo do caixa que roda **na transação de quem chama**.
 *
 * A venda avulsa e o pagamento do tutor gravam o próprio registro e o movimento do
 * caixa juntos: ou os dois vingam, ou nenhum. É o mesmo motivo da baixa do estoque na
 * venda (RN-11 do MOD-ESTOQUE) — uma venda gravada sem o dinheiro no caixa é a primeira
 * diferença do fechamento, e ninguém saberia de onde ela veio.
 *
 * Quem chama de fora do módulo passa por uma porta (`inventory/cash-port.ts`,
 * `ledger/cash-port.ts`), e não importa daqui direto.
 */

export interface OpenSessionRef {
  id: string
}

/**
 * O caixa aberto do estabelecimento, travado.
 *
 * A trava serializa o movimento contra o fechamento: sem ela, uma venda que chega no
 * mesmo instante do "Fechar caixa" entraria numa sessão cuja contagem já foi congelada.
 * Com ela, ou a venda entra antes e o fechamento a soma, ou o fechamento vence e a
 * venda não acha caixa aberto.
 */
export async function lockOpenSession(tx: TenantTransaction): Promise<OpenSessionRef | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions WHERE status = 'OPEN' FOR UPDATE
  `
  return rows[0] ?? null
}

/** Uma sessão específica, travada, se ainda estiver aberta. */
export async function lockSessionIfOpen(
  tx: TenantTransaction,
  sessionId: string,
): Promise<OpenSessionRef | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions WHERE id = ${sessionId}::uuid AND status = 'OPEN' FOR UPDATE
  `
  return rows[0] ?? null
}

export interface CashMovementInput {
  sessionId: string
  type: CashMovementType
  method: CashMethod
  /** Com sinal: positivo entra na gaveta, negativo sai. */
  amountCents: number
  sourceType?: 'PRODUCT_SALE' | 'PAYMENT' | null
  sourceId?: string | null
  /** O que a linha diz. Nunca dado pessoal: o nome do tutor é lido na hora de mostrar. */
  reason?: string | null
}

export async function postCashMovement(
  tx: TenantTransaction,
  actor: ActorContext,
  input: CashMovementInput,
): Promise<{ id: string }> {
  return tx.cashMovement.create({
    data: {
      tenantId: actor.tenantId,
      sessionId: input.sessionId,
      type: input.type,
      method: input.method,
      amountCents: BigInt(input.amountCents),
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reason: input.reason ?? null,
      createdBy: actor.actorUserId ?? null,
    },
    select: { id: true },
  })
}

/** O movimento que uma origem já deixou no caixa, com o sentido pedido. */
export async function findMovementBySource(
  tx: TenantTransaction,
  type: CashMovementType,
  sourceId: string,
): Promise<{ sessionId: string; method: CashMethod; amountCents: bigint } | null> {
  const row = await tx.cashMovement.findFirst({
    where: { type, sourceId },
    select: { sessionId: true, method: true, amountCents: true },
  })
  return row ? { ...row, method: row.method as CashMethod } : null
}
