import { withTenant, type TenantTransaction } from '@petshop/db'
import type { CreateLedgerEntryInput, EntryCategory } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { alreadyReversed, forbidden, notFound } from './errors.js'
import { publishEvent } from '../../shared/events.js'
import { recordMetric } from '../../shared/logger.js'
import { invalidateAccount } from '../../shared/redis.js'
import type { ActorContext } from './actor.js'
import { tenantOptions } from './actor.js'
import { lockAccount, openAccount, postEntry, type PostedEntry } from './accounts.js'
import { absorbLeftoverCredit } from './allocation.js'
import { openCipher } from './crypto.js'
import { confirmIdempotency, hashPayload, reserveIdempotency } from './idempotency.js'
import { toEntryResponse, type LedgerEntryResponse } from './mapper.js'

/**
 * Lançamento manual e estorno (MOD-LEDGER-02 e 05).
 *
 * RN-01 — **imutabilidade absoluta**: um lançamento nasce definitivo. Não existe
 * `PATCH /v1/ledger/entries/:id`, e não é omissão. Correção é sempre um lançamento
 * inverso vinculado por `reverses_entry_id`, e o par (erro + correção) fica visível no
 * extrato. É o que separa um livro-caixa auditável de uma planilha.
 */

/**
 * Publica o par de eventos que toda movimentação de saldo dispara.
 *
 * `lancamento.criado` e `saldo.alterado` andam juntos porque respondem a perguntas
 * diferentes: o primeiro é "o que aconteceu" (o CRM e o portal montam a linha do
 * extrato com ele), o segundo é "quanto ficou" (o tutor-service reescreve
 * `tutors.balance_cents`). O `balanceCents` redundante no primeiro existe porque o
 * consumidor do tutor-service já lia esse campo antes deste módulo existir.
 */
async function publishPosted(
  actor: ActorContext,
  tutorId: string,
  entry: PostedEntry,
): Promise<void> {
  await publishEvent('lancamento.criado', {
    tenantId: actor.tenantId,
    entryId: entry.id,
    tutorId,
    direction: entry.direction,
    amountCents: entry.amountCents,
    category: entry.category,
    balanceAfterCents: entry.balanceAfterCents,
    balanceCents: entry.balanceAfterCents,
    occurredAt: entry.occurredAt.toISOString(),
  })

  await publishEvent('saldo.alterado', {
    tenantId: actor.tenantId,
    tutorId,
    balanceCents: entry.balanceAfterCents,
    previousBalanceCents: entry.previousBalanceCents,
  })

  recordMetric({
    metric: 'ledger_entry_created_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  await invalidateAccount(actor.tenantId, tutorId)
}

/** Reexportado para os outros módulos publicarem o mesmo par sem duplicar a conta. */
export { publishPosted }

/**
 * AC-03 de MOD-LEDGER-02 — a recepção vende ração no balcão.
 *
 * `canCredit` chega da permissão, não do papel: quem decide é a matriz do RBAC, e
 * repetir "é TENANT_ADMIN?" aqui criaria uma segunda fonte de verdade. O corte é o do
 * §9 — a recepção lança débito (vendeu um produto), mas crédito e desconto são do
 * gestor, porque crédito sem contrapartida é dinheiro saindo do caixa.
 */
export async function createManualEntry(
  actor: ActorContext,
  input: CreateLedgerEntryInput,
  capabilities: { canCredit: boolean },
) {
  if (input.direction === 'CREDIT' && !capabilities.canCredit) {
    throw forbidden('Somente um administrador pode lançar crédito ou conceder desconto')
  }

  const requestHash = hashPayload(input as unknown as Record<string, unknown>)

  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const reservation = await reserveIdempotency(
        tx,
        actor.tenantId,
        'POST /v1/ledger/entries',
        input.idempotencyKey,
        requestHash,
      )
      if (reservation.existingResourceId) {
        return { repeated: true as const, entryId: reservation.existingResourceId }
      }

      const account = await openAccount(tx, actor.tenantId, input.tutorId)
      const cipher = input.internalNotes ? await openCipher(tx, actor.tenantId) : null

      const entry = await postEntry(tx, actor, account.balanceCents, {
        accountId: account.id,
        tutorId: input.tutorId,
        direction: input.direction,
        amountCents: input.amountCents,
        category: input.category as EntryCategory,
        description: input.description,
        internalNotesEncrypted:
          cipher && input.internalNotes ? cipher.encrypt(input.internalNotes) : null,
        sourceType: 'MANUAL',
        petId: input.petId ?? null,
        ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
      })

      // RN-07: se havia crédito solto de um pagamento anterior, ele quita este débito
      // agora — senão o extrato mostraria "você tem crédito" e "você deve" pelo mesmo
      // dinheiro.
      if (input.direction === 'DEBIT') {
        await absorbLeftoverCredit(tx, actor.tenantId, account.id, entry.id, input.amountCents)
      }

      await confirmIdempotency(
        tx,
        actor.tenantId,
        'POST /v1/ledger/entries',
        input.idempotencyKey,
        entry.id,
      )

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: input.category === 'DISCOUNT' ? 'ledger.discount_granted' : 'ledger.entry_created',
        entity: 'ledger_entry',
        entityId: entry.id,
        after: {
          tutorId: input.tutorId,
          direction: input.direction,
          amountCents: input.amountCents,
          category: input.category,
          description: input.description,
          balanceAfterCents: entry.balanceAfterCents,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { repeated: false as const, entryId: entry.id, entry }
    },
    tenantOptions(actor),
  )

  // RN-04: a repetição devolve o mesmo recurso e **não** republica o evento — o
  // consumidor do outro lado somaria o saldo duas vezes.
  if (!result.repeated) {
    await publishPosted(actor, input.tutorId, result.entry)
  }

  return { repeated: result.repeated, entryId: result.entryId }
}

/**
 * MOD-LEDGER-05 — estorno por contrapartida.
 *
 * Gera um lançamento **inverso**, de mesmo valor e direção oposta, vinculado nos dois
 * sentidos (`reverses_entry_id` / `reversed_by_entry_id`). O original vai a `REVERSED`
 * mas continua no extrato: o AC-04 de MOD-LEDGER-10 é explícito em que o par
 * (taxa + perdão) permanece visível — o gesto comercial fica registrado, não escondido.
 *
 * RN-25: só `TENANT_ADMIN` (a rota exige `finance:refund`). O balcão registra, o
 * gestor corrige.
 */
export async function reverseEntry(actor: ActorContext, entryId: string, reason: string) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const original = await tx.ledgerEntry.findFirst({
        where: { id: entryId },
        select: {
          id: true,
          tutorId: true,
          accountId: true,
          direction: true,
          amountCents: true,
          category: true,
          description: true,
          status: true,
          petId: true,
        },
      })
      if (!original) throw notFound('Lançamento não encontrado')
      if (original.status === 'REVERSED') {
        throw alreadyReversed('Este lançamento já foi estornado')
      }

      const account = await lockAccount(tx, actor.tenantId, original.tutorId)

      const reversal = await postEntry(tx, actor, account.balanceCents, {
        accountId: original.accountId,
        tutorId: original.tutorId,
        direction: original.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amountCents: Number(original.amountCents),
        category: reversalCategory(original.category),
        description: `Estorno: ${original.description}`.slice(0, 200),
        sourceType: 'SYSTEM',
        petId: original.petId,
        reversesEntryId: original.id,
      })

      await tx.ledgerEntry.update({
        where: { id: original.id },
        data: { status: 'REVERSED', reversedByEntryId: reversal.id },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.entry_reversed',
        entity: 'ledger_entry',
        entityId: original.id,
        before: { status: 'POSTED', amountCents: Number(original.amountCents) },
        after: { status: 'REVERSED', reversalEntryId: reversal.id, reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { tutorId: original.tutorId, reversal }
    },
    tenantOptions(actor),
  )

  await publishEvent('lancamento.estornado', {
    tenantId: actor.tenantId,
    entryId,
    tutorId: result.tutorId,
    reversalEntryId: result.reversal.id,
    reason,
    reversedBy: actor.actorUserId ?? null,
    balanceCents: result.reversal.balanceAfterCents,
  })
  await publishPosted(actor, result.tutorId, result.reversal)

  return { entryId, reversalEntryId: result.reversal.id }
}

/**
 * A categoria da contrapartida.
 *
 * Não é sempre a mesma do original: perdoar uma taxa de falta é `FEE_WAIVER`, e é
 * assim que o extrato consegue dizer "a multa foi perdoada" em vez de "houve um
 * crédito de R$ 50" — a diferença entre um gesto comercial legível e um lançamento
 * que ninguém sabe explicar.
 */
function reversalCategory(category: EntryCategory): EntryCategory {
  if (category === 'NO_SHOW_FEE') return 'FEE_WAIVER'
  if (category === 'PAYMENT') return 'PAYMENT_REVERSAL'
  return 'ADJUSTMENT'
}

/**
 * Detalhe de um lançamento, para `GET /v1/ledger/entries/:id`.
 *
 * O retorno é anotado (`LedgerEntryResponse`, uma interface declarada) e não inferido:
 * sem isso o TypeScript tenta nomear o tipo gerado do Prisma pelo caminho dentro de
 * `node_modules` e recusa emitir (TS2742). Mapear aqui, e não na rota, é o que dá o
 * tipo nomeável de graça.
 */
export async function getEntry(
  actor: ActorContext,
  entryId: string,
  includeInternal: boolean,
): Promise<LedgerEntryResponse> {
  return withTenant(actor.tenantId, async (tx) => {
    const entry = await tx.ledgerEntry.findFirst({ where: { id: entryId } })
    if (!entry) throw notFound('Lançamento não encontrado')

    const encrypted = entry.internalNotesEncrypted
    const internalNotes =
      includeInternal && encrypted ? (await openCipher(tx, actor.tenantId)).decrypt(encrypted) : null

    return toEntryResponse(entry, { includeInternal, internalNotes })
  })
}

/**
 * Resumo da conta para o cabeçalho da ficha do tutor (MOD-LEDGER-01).
 *
 * Os agregados de débito aberto saem numa consulta só, porque o SLO do endpoint é
 * 100ms e ele é chamado em toda abertura da ficha.
 */
export async function accountSummary(tx: TenantTransaction, tenantId: string, tutorId: string) {
  // A conta é criada preguiçosamente, o **tutor** não. RN-17 diz que quem não tem
  // movimentação vê saldo zero; não diz que um id inexistente — ou de outro tenant —
  // deva parecer um cliente em dia. Sem esta linha, um erro de digitação devolveria
  // "R$ 0,00" com toda a confiança do mundo.
  const tutor = await tx.tutor.findFirst({ where: { id: tutorId }, select: { id: true } })
  if (!tutor) throw notFound('Tutor não encontrado')

  const account = await tx.ledgerAccount.findFirst({
    where: { tutorId },
    select: {
      id: true,
      balanceCents: true,
      currency: true,
      lastEntryAt: true,
      lastPaymentAt: true,
      needsReview: true,
    },
  })

  // RN-17: conta ainda não existe = tutor sem movimentação. Zero, não 404.
  if (!account) {
    return {
      balanceCents: 0,
      currency: 'BRL',
      openDebitsCents: 0,
      openDebitsCount: 0,
      oldestOpenDebitAt: null as Date | null,
      lastEntryAt: null as Date | null,
      lastPaymentAt: null as Date | null,
      needsReview: false,
    }
  }

  const rows = await tx.$queryRaw<
    { open_cents: bigint | null; open_count: bigint; oldest: Date | null }[]
  >`
    SELECT COALESCE(SUM(amount_cents - settled_cents), 0) AS open_cents,
           COUNT(*)                                       AS open_count,
           MIN(occurred_at)                               AS oldest
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${account.id}::uuid
       AND direction = 'DEBIT'
       AND status = 'POSTED'
       AND settled_cents < amount_cents
  `
  const agg = rows[0]

  return {
    balanceCents: Number(account.balanceCents),
    currency: account.currency,
    openDebitsCents: Number(agg?.open_cents ?? 0),
    openDebitsCount: Number(agg?.open_count ?? 0),
    oldestOpenDebitAt: agg?.oldest ?? null,
    lastEntryAt: account.lastEntryAt,
    lastPaymentAt: account.lastPaymentAt,
    needsReview: account.needsReview,
  }
}
