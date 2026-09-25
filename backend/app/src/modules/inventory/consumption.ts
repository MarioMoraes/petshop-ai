import { AppError, NO_BATCH_CODE, zonedDate, DEFAULT_TIMEZONE } from '@petshop/shared-types'
import { Prisma, withTenant, type TenantTransaction } from '@petshop/db'
import type {
  InternalUseInput,
  LotTrace,
  ProductUsed,
  StockMovementResult,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { idempotencyConflict, invalid, notFound, productInactive } from './errors.js'
import { fefo, lockLotsOf, type Allocation } from './lots.js'
import {
  dateOnly,
  expiryWindow,
  quantityText,
  toLotResponse,
  toMovementResponse,
} from './mapper.js'
import {
  ensureLot,
  findByIdempotencyKey,
  isIdempotencyCollision,
  recordMovement,
  type MovementRow,
} from './movements.js'

/**
 * MOD-ESTOQUE-07/08/10 — o que se gasta com o pet, o que se gasta no dia e quem recebeu
 * cada lote.
 *
 * O consumo do atendimento **não recusa saldo** (RN-06): o banho já foi dado, e um
 * sistema que se recusa a registrar o que aconteceu só ensina a equipe a não registrar.
 * O lote fica negativo e aparece no filtro de saldo negativo.
 */

function notSupply(name: string): AppError {
  return new AppError('ERR_INV_008', `${name} é produto de venda, e não insumo`)
}

// ─── O consumo do atendimento (MOD-ESTOQUE-07) ───────────────────────────────

export interface ConsumptionContext {
  attendanceItemId: string
  petId: string
  tutorId: string
  /** A data do atendimento, e não a de hoje: é contra ela que se confere a validade. */
  performedAt: Date
}

/** Quanto este item do atendimento já tirou de cada lote, líquido de devoluções. */
async function consumedByLot(
  tx: TenantTransaction,
  attendanceItemId: string,
): Promise<Map<string, Prisma.Decimal>> {
  const movements = await tx.stockMovement.findMany({
    where: { sourceType: 'ATTENDANCE_ITEM', sourceId: attendanceItemId },
    select: { lotId: true, quantity: true },
  })
  const net = new Map<string, Prisma.Decimal>()
  for (const movement of movements) {
    const previous = net.get(movement.lotId) ?? new Prisma.Decimal(0)
    net.set(movement.lotId, previous.minus(movement.quantity))
  }
  return net
}

/**
 * Leva o estoque a bater com a lista de produtos do item — **pela diferença** (AC-02).
 *
 * Não é "estorna tudo e baixa de novo": editar de 2 frascos para 1 grava um movimento
 * de +1, e o histórico do lote conta a correção como ela foi. A conta é refeita a partir
 * dos movimentos já gravados para o item, e não de um campo guardado, e é isso que a
 * torna idempotente: repetir a mesma edição encontra diferença zero e não grava nada.
 *
 * Devolve a lista com o retrato normalizado — `name` e `batch` preenchidos do cadastro —,
 * que é o que o prontuário guarda.
 */
export async function syncItemConsumption(
  tx: TenantTransaction,
  actor: ActorContext,
  context: ConsumptionContext,
  desired: ProductUsed[],
): Promise<ProductUsed[]> {
  // Duas edições do mesmo atendimento ao mesmo tempo leriam o mesmo "já consumido".
  await tx.$queryRaw`SELECT id FROM attendance_items WHERE id = ${context.attendanceItemId}::uuid FOR UPDATE`

  const settings = await tx.tenantSettings.findFirst({
    where: { tenantId: actor.tenantId },
    select: { timezone: true },
  })
  const day = zonedDate(context.performedAt, settings?.timezone ?? DEFAULT_TIMEZONE)

  const normalized: ProductUsed[] = []
  const wanted = new Map<string, Prisma.Decimal>()

  for (const line of desired) {
    if (!line.productId) {
      normalized.push(line)
      continue
    }
    if (!line.lotId) throw invalid(`Escolha o lote de ${line.name}`)
    if (!line.quantity) throw invalid(`Informe quanto de ${line.name} foi usado`)

    const lot = await tx.stockLot.findFirst({
      where: { id: line.lotId },
      include: { product: true },
    })
    if (!lot || lot.product.deletedAt) throw notFound('Lote não encontrado')
    if (lot.productId !== line.productId) throw invalid('O lote escolhido não é deste produto')
    if (lot.product.kind === 'RETAIL') throw notSupply(lot.product.name)

    // AC-06: vacina vencida não é aviso, é erro. Só vale para o produto que controla
    // validade — o lote de shampoo com data vencida na caixa segue a vida.
    const expires = dateOnly(lot.expiresAt)
    if (lot.product.tracksExpiry && expires !== null && expires < day) {
      throw new AppError(
        'ERR_INV_011',
        `O lote ${lot.batchCode} de ${lot.product.name} venceu em ${expires.split('-').reverse().join('/')}`,
      )
    }

    const quantity = new Prisma.Decimal(line.quantity)
    wanted.set(lot.id, (wanted.get(lot.id) ?? new Prisma.Decimal(0)).plus(quantity))
    normalized.push({
      name: lot.product.name,
      ...(lot.batchCode === NO_BATCH_CODE ? {} : { batch: lot.batchCode }),
      productId: lot.productId,
      lotId: lot.id,
      quantity: quantity.toString(),
    })
  }

  const current = await consumedByLot(tx, context.attendanceItemId)
  const lots = new Set([...wanted.keys(), ...current.keys()])
  for (const lotId of [...lots].sort()) {
    const delta = (wanted.get(lotId) ?? new Prisma.Decimal(0)).minus(
      current.get(lotId) ?? new Prisma.Decimal(0),
    )
    if (delta.isZero()) continue
    await recordMovement(tx, actor, {
      lotId,
      type: delta.greaterThan(0) ? 'CONSUMPTION_OUT' : 'RETURN_IN',
      quantity: delta.negated(),
      sourceType: 'ATTENDANCE_ITEM',
      sourceId: context.attendanceItemId,
      ...(delta.lessThan(0) ? { reason: 'Correção do atendimento' } : {}),
      petId: context.petId,
      tutorId: context.tutorId,
      occurredAt: context.performedAt,
    })
  }

  return normalized
}

/**
 * AC-04: anular o atendimento devolve tudo o que ele consumiu, ao lote de onde saiu.
 *
 * Roda sempre, com plano ou sem: devolver o que foi tirado nunca é o erro, e o
 * estabelecimento que desceu do Pro ainda tem o estoque que tinha.
 */
export async function returnAttendanceConsumption(
  tx: TenantTransaction,
  actor: ActorContext,
  attendanceItemIds: string[],
  reason: string,
): Promise<void> {
  for (const itemId of attendanceItemIds) {
    const current = await consumedByLot(tx, itemId)
    if (current.size === 0) continue
    // A devolução leva o pet e o tutor do consumo: é o que faz o rastreio de lote
    // mostrar que aquele pet, afinal, não recebeu.
    const origin = await tx.stockMovement.findFirst({
      where: { sourceType: 'ATTENDANCE_ITEM', sourceId: itemId },
      select: { petId: true, tutorId: true },
    })
    for (const [lotId, net] of [...current.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (net.lessThanOrEqualTo(0)) continue
      await recordMovement(tx, actor, {
        lotId,
        type: 'VOID_RETURN',
        quantity: net,
        sourceType: 'ATTENDANCE_ITEM',
        sourceId: itemId,
        reason,
        petId: origin?.petId ?? null,
        tutorId: origin?.tutorId ?? null,
      })
    }
  }
}

// ─── O uso interno (MOD-ESTOQUE-08) ──────────────────────────────────────────

/**
 * O shampoo que acabou no banho, sem pet nenhum.
 *
 * Sai por FEFO, e o que o FEFO não cobre sai do primeiro lote assim mesmo — o frasco já
 * foi usado (RN-06). Lote vencido, aqui, é aviso e não erro (RN-14): o uso interno não
 * chega ao animal por uma seringa.
 */
export async function registerInternalUse(
  actor: ActorContext,
  input: InternalUseInput,
): Promise<StockMovementResult> {
  const same = (movement: MovementRow) =>
    movement.type === 'CONSUMPTION_OUT' && movement.productId === input.productId

  const run = () =>
    withTenant(
      actor.tenantId,
      async (tx) => {
        const existing = await findByIdempotencyKey(tx, input.idempotencyKey)
        if (existing) {
          if (!same(existing)) throw idempotencyConflict()
          return summarize(tx, actor.tenantId, existing, true)
        }

        const product = await tx.product.findFirst({
          where: { id: input.productId, deletedAt: null },
        })
        if (!product) throw notFound()
        if (!product.active) throw productInactive()
        if (product.kind === 'RETAIL') throw notSupply(product.name)

        const requested = new Prisma.Decimal(input.quantity)
        const lots = await lockLotsOf(tx, [product.id])
        let allocations: Allocation[]

        if (input.lotId) {
          if (!lots.some((lot) => lot.id === input.lotId)) {
            throw invalid('O lote escolhido não é deste produto')
          }
          allocations = [{ lotId: input.lotId, quantity: requested }]
        } else {
          const { today } = await expiryWindow(tx, actor.tenantId)
          const plan = fefo(lots, requested, today)
          allocations = plan.allocations
          const covered = allocations.reduce(
            (sum, allocation) => sum.plus(allocation.quantity),
            new Prisma.Decimal(0),
          )
          const rest = requested.minus(covered)
          if (rest.greaterThan(0)) {
            // O que não cabe nos lotes com saldo sai do lote que venceria primeiro, ou do
            // lote implícito se o produto nunca teve entrada.
            const target =
              allocations[0]?.lotId ??
              lots[0]?.id ??
              (await ensureLot(tx, actor.tenantId, product.id, NO_BATCH_CODE, null)).lot.id
            const index = allocations.findIndex((allocation) => allocation.lotId === target)
            if (index >= 0) {
              allocations[index] = {
                lotId: target,
                quantity: allocations[index]!.quantity.plus(rest),
              }
            } else {
              allocations.push({ lotId: target, quantity: rest })
            }
          }
        }

        let first: MovementRow | null = null
        for (const [position, allocation] of allocations.entries()) {
          const movement = await recordMovement(tx, actor, {
            lotId: allocation.lotId,
            type: 'CONSUMPTION_OUT',
            quantity: allocation.quantity.negated(),
            sourceType: 'INTERNAL_USE',
            // A chave vai no primeiro movimento: o índice é único por movimento, e o
            // primeiro basta para reconhecer a repetição.
            idempotencyKey: position === 0 ? input.idempotencyKey : null,
            reason: input.reason?.trim() || null,
          })
          first ??= movement
        }

        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'stock.internal_use',
          entity: 'product',
          entityId: product.id,
          after: { quantity: requested.toString(), reason: input.reason ?? null },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })

        return summarize(tx, actor.tenantId, first!, false)
      },
      tenantOptions(actor),
    )

  try {
    return await run()
  } catch (error) {
    if (!isIdempotencyCollision(error)) throw error
    return run()
  }
}

async function summarize(
  tx: TenantTransaction,
  tenantId: string,
  movement: MovementRow,
  repeated: boolean,
): Promise<StockMovementResult> {
  const window = await expiryWindow(tx, tenantId)
  const lot = await tx.stockLot.findUniqueOrThrow({ where: { id: movement.lotId } })
  return { movement: toMovementResponse(movement), lot: toLotResponse(lot, window), repeated }
}

// ─── Quem recebeu o lote (MOD-ESTOQUE-10) ────────────────────────────────────

/**
 * A pergunta que justifica o módulo para a clínica: o fabricante recolheu o lote, quais
 * pets o receberam?
 *
 * Entram os movimentos que apontam pet ou tutor — atendimento e venda —, com as
 * devoluções junto, para a lista não dizer que recebeu quem devolveu. O telefone não
 * vem: a lista leva à ficha, e a ficha tem a sua própria permissão.
 */
export async function traceLot(actor: ActorContext, lotId: string): Promise<LotTrace> {
  return withTenant(actor.tenantId, async (tx) => {
    const lot = await tx.stockLot.findFirst({
      where: { id: lotId },
      include: { product: { select: { name: true, unit: true } } },
    })
    if (!lot) throw notFound('Lote não encontrado')

    const movements = await tx.stockMovement.findMany({
      where: { lotId, OR: [{ petId: { not: null } }, { tutorId: { not: null } }] },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 500,
    })

    const petIds = [...new Set(movements.map((m) => m.petId).filter((id) => id !== null))]
    const tutorIds = [...new Set(movements.map((m) => m.tutorId).filter((id) => id !== null))]
    const [pets, tutors] = await Promise.all([
      petIds.length
        ? tx.pet.findMany({ where: { id: { in: petIds } }, select: { id: true, name: true } })
        : [],
      tutorIds.length
        ? tx.tutor.findMany({
            where: { id: { in: tutorIds } },
            select: { id: true, fullName: true, socialName: true },
          })
        : [],
    ])
    const petName = new Map(pets.map((pet) => [pet.id, pet.name]))
    const tutorName = new Map(tutors.map((tutor) => [tutor.id, tutor.socialName ?? tutor.fullName]))

    return {
      lot: toLotResponse(lot, await expiryWindow(tx, actor.tenantId)),
      productName: lot.product.name,
      unit: lot.product.unit,
      entries: movements.map((movement) => ({
        movementId: movement.id,
        type: movement.type,
        occurredAt: movement.occurredAt.toISOString(),
        quantity: quantityText(new Prisma.Decimal(movement.quantity).negated()),
        petId: movement.petId,
        petName: movement.petId ? (petName.get(movement.petId) ?? null) : null,
        tutorId: movement.tutorId,
        tutorName: movement.tutorId ? (tutorName.get(movement.tutorId) ?? null) : null,
      })),
    }
  })
}
