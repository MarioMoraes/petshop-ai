import { createHash } from 'node:crypto'
import { Prisma, type TenantTransaction } from '@petshop/db'
import { idempotencyConflict } from './errors.js'

/**
 * RN-04 — idempotência de API.
 *
 * Todo POST que move dinheiro exige `idempotencyKey`. Repetir com o **mesmo** payload
 * devolve o mesmo recurso; com payload diferente, `ERR_LEDGER_012`.
 *
 * É uma garantia diferente da do índice único `(source_type, source_id, direction)`,
 * que cobre evento reentregue pelo broker. Esta cobre o duplo clique no balcão e o
 * retry do navegador — casos em que não há `source_id` nenhum para comparar, porque a
 * origem é `MANUAL`.
 */

/**
 * SHA-256 do payload com as chaves ordenadas.
 *
 * A ordenação importa: `{a,b}` e `{b,a}` são a mesma requisição, e tratá-las como
 * divergentes faria o cliente receber 409 por ter serializado o JSON em outra ordem.
 * `idempotencyKey` sai do hash — ela é a identidade, não o conteúdo.
 */
export function hashPayload(payload: Record<string, unknown>): string {
  const normalized = JSON.stringify(sortValue(stripKey(payload)))
  return createHash('sha256').update(normalized).digest('hex')
}

function stripKey(payload: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey: _ignored, ...rest } = payload
  return rest
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([itemKey, item]) => [itemKey, sortValue(item)]),
  )
}

export interface IdempotencyOutcome {
  /** Id do recurso criado na primeira chamada. Presente = repetição. */
  existingResourceId: string | null
}

/**
 * Reserva a chave dentro da transação da operação.
 *
 * Ficar na mesma transação é o ponto: se o lançamento falhar depois, a chave some
 * junto e o cliente pode legitimamente tentar de novo. Reservá-la fora deixaria a
 * chave "queimada" apontando para um recurso que não existe.
 *
 * A chamada é feita **antes** de criar o recurso, com `resource_id` provisório, e
 * `confirmIdempotency` grava o id real no fim. Duas fases porque o id só nasce depois.
 */
export async function reserveIdempotency(
  tx: TenantTransaction,
  tenantId: string,
  endpoint: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyOutcome> {
  const existing = await tx.ledgerIdempotencyKey.findFirst({
    where: { tenantId, endpoint, key },
    select: { requestHash: true, resourceId: true },
  })

  if (existing) {
    if (existing.requestHash !== requestHash) throw idempotencyConflict()
    return { existingResourceId: existing.resourceId }
  }

  try {
    await tx.ledgerIdempotencyKey.create({
      data: {
        tenantId,
        endpoint,
        key,
        requestHash,
        // Substituído por `confirmIdempotency`. A chave em si já está reservada, que é
        // o que impede a segunda requisição concorrente de criar um recurso paralelo.
        resourceId: key,
      },
    })
  } catch (error) {
    // Corrida: duas requisições idênticas chegaram juntas e a outra ganhou o índice
    // único. Quem perde relê — e vai encontrar o `resource_id` da vencedora, que é
    // exatamente o comportamento que a idempotência promete.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await tx.ledgerIdempotencyKey.findFirst({
        where: { tenantId, endpoint, key },
        select: { requestHash: true, resourceId: true },
      })
      if (winner && winner.requestHash !== requestHash) throw idempotencyConflict()
      return { existingResourceId: winner?.resourceId ?? null }
    }
    throw error
  }

  return { existingResourceId: null }
}

export async function confirmIdempotency(
  tx: TenantTransaction,
  tenantId: string,
  endpoint: string,
  key: string,
  resourceId: string,
): Promise<void> {
  await tx.ledgerIdempotencyKey.updateMany({
    where: { tenantId, endpoint, key },
    data: { resourceId },
  })
}
