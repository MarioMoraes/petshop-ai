import type { TenantTransaction } from '@petshop/db'
import type { EntryCategory, EntryDirection, EntrySourceType } from '@petshop/shared-types'
import { MAX_MONEY_CENTS } from '@petshop/shared-types'
import { invalid, notFound } from '../../lib/errors.js'
import type { ActorContext } from './actor.js'

/**
 * A conta corrente e o único caminho de escrita do saldo (MOD-LEDGER-01 e 02).
 *
 * Tudo o que mexe em dinheiro neste serviço passa por `postEntry`. Não é elegância:
 * é a única forma de garantir que `balance_after_cents` sempre corresponda ao saldo
 * real no instante do lançamento, que é a coluna de que o extrato depende para não
 * somar a tabela inteira a cada página — e de que o job de reconciliação depende para
 * detectar que alguém escreveu por fora.
 */

interface AccountRow {
  id: string
  balance_cents: bigint
  version: number
  needs_review: boolean
}

/**
 * RN-17 — a conta nasce preguiçosamente.
 *
 * Não se cria conta no cadastro do tutor. A primeira consulta ou o primeiro
 * lançamento a cria com saldo zero, e é por isso que extrato de tutor recém-cadastrado
 * devolve 200 com lista vazia, nunca 404 (AC-04 de MOD-LEDGER-06).
 *
 * O `ON CONFLICT DO NOTHING` seguido de `SELECT` resolve a corrida de dois pedidos
 * simultâneos para o mesmo tutor novo sem precisar de retry na aplicação.
 */
export async function openAccount(tx: TenantTransaction, tenantId: string, tutorId: string) {
  const exists = await tx.tutor.findFirst({ where: { id: tutorId }, select: { id: true } })
  if (!exists) throw notFound('Tutor não encontrado')

  await tx.$executeRaw`
    INSERT INTO ledger_accounts (tenant_id, tutor_id)
    VALUES (${tenantId}::uuid, ${tutorId}::uuid)
    ON CONFLICT (tenant_id, tutor_id) DO NOTHING
  `

  return lockAccount(tx, tenantId, tutorId)
}

/**
 * Trava a conta para escrita.
 *
 * `FOR UPDATE` e não optimistic locking: com `version` bastaria detectar a corrida
 * *depois*, e o caminho de recuperação seria refazer o lançamento — que é justamente a
 * operação que não pode ser refeita às cegas. Serializar duas recepcionistas
 * registrando pagamento do mesmo tutor custa milissegundos.
 */
export async function lockAccount(tx: TenantTransaction, tenantId: string, tutorId: string) {
  const rows = await tx.$queryRaw<AccountRow[]>`
    SELECT id, balance_cents, version, needs_review
      FROM ledger_accounts
     WHERE tenant_id = ${tenantId}::uuid AND tutor_id = ${tutorId}::uuid
     FOR UPDATE
  `
  const row = rows[0]
  if (!row) throw notFound('Conta não encontrada')

  return {
    id: row.id,
    balanceCents: Number(row.balance_cents),
    version: row.version,
    needsReview: row.needs_review,
  }
}

export interface PostEntryInput {
  accountId: string
  tutorId: string
  direction: EntryDirection
  /** Sempre positivo. Zero só é aceito em `PACKAGE_REDEMPTION` (o CHECK garante). */
  amountCents: number
  category: EntryCategory
  description: string
  internalNotesEncrypted?: string | null
  sourceType: EntrySourceType
  sourceId?: string | null
  petId?: string | null
  occurredAt?: Date
  reversesEntryId?: string | null
}

export interface PostedEntry {
  id: string
  balanceAfterCents: number
  previousBalanceCents: number
  amountCents: number
  direction: EntryDirection
  category: EntryCategory
  occurredAt: Date
}

/**
 * Grava o lançamento e move o saldo — **na mesma transação**, sempre.
 *
 * O chamador é responsável por já ter travado a conta com `lockAccount`/`openAccount`;
 * o saldo chega como parâmetro para deixar isso explícito. Ler a conta aqui dentro
 * esconderia a trava e permitiria que alguém chamasse `postEntry` fora dela.
 *
 * Convenção de sinal (RN-02): `CREDIT` soma, `DEBIT` subtrai. Saldo negativo é
 * dívida. É a mesma de `tutors.balance_cents`, que este módulo alimenta por evento.
 */
export async function postEntry(
  tx: TenantTransaction,
  actor: ActorContext,
  balanceCents: number,
  input: PostEntryInput,
): Promise<PostedEntry> {
  assertAmount(input.amountCents, input.category)

  const occurredAt = input.occurredAt ?? new Date()
  // RN-23: `occurred_at` pode ser retroativa (o serviço de ontem lançado hoje);
  // `posted_at` nunca. Data futura seria lançar o que ainda não aconteceu.
  if (occurredAt.getTime() > Date.now()) {
    throw invalid('Lançamento não pode ter data futura')
  }

  const signed = input.direction === 'CREDIT' ? input.amountCents : -input.amountCents
  const balanceAfterCents = balanceCents + signed

  const entry = await tx.ledgerEntry.create({
    data: {
      tenantId: actor.tenantId,
      accountId: input.accountId,
      tutorId: input.tutorId,
      direction: input.direction,
      amountCents: BigInt(input.amountCents),
      balanceAfterCents: BigInt(balanceAfterCents),
      category: input.category,
      description: input.description,
      internalNotesEncrypted: input.internalNotesEncrypted ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      petId: input.petId ?? null,
      occurredAt,
      reversesEntryId: input.reversesEntryId ?? null,
      createdBy: actor.actorUserId ?? null,
    },
    select: { id: true },
  })

  await tx.ledgerAccount.update({
    where: { id: input.accountId },
    data: {
      balanceCents: BigInt(balanceAfterCents),
      version: { increment: 1 },
      lastEntryAt: new Date(),
    },
  })

  return {
    id: entry.id,
    balanceAfterCents,
    previousBalanceCents: balanceCents,
    amountCents: input.amountCents,
    direction: input.direction,
    category: input.category,
    occurredAt,
  }
}

/**
 * AC-04 de MOD-LEDGER-02.
 *
 * O teto de R$ 1.000.000 não existe para limitar o negócio — nenhum banho custa isso.
 * Existe para que um dedo escorregando no teclado numérico vire 422 e não uma dívida
 * de sete dígitos na conta de alguém.
 */
export function assertAmount(amountCents: number, category: EntryCategory): void {
  // O lançamento informativo de uso de pacote vale zero de propósito: ele existe para
  // o consumo aparecer no extrato, não para cobrar.
  const minimum = category === 'PACKAGE_REDEMPTION' ? 0 : 1

  if (!Number.isInteger(amountCents) || amountCents < minimum) {
    throw invalid('Valor inválido para lançamento')
  }
  if (amountCents > MAX_MONEY_CENTS) {
    throw invalid('Valor inválido para lançamento')
  }
}
