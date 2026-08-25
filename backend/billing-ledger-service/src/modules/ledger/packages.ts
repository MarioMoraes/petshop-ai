import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import type {
  CreatePackagePurchaseInput,
  CreateServicePackageInput,
  UpdatePackagePurchaseInput,
  UpdateServicePackageInput,
} from '@petshop/shared-types'
import { PAYMENT_METHOD_LABELS, formatBRL } from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { forbidden, notFound, packageUnavailable } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { logger, recordMetric } from '../../lib/logger.js'
import { invalidatePackages } from '../../lib/redis.js'
import type { ActorContext } from './actor.js'
import { tenantOptions } from './actor.js'
import { openAccount, postEntry } from './accounts.js'
import { applyAllocations } from './allocation.js'
import { openCipher } from './crypto.js'
import { publishPosted } from './entries.js'
import { confirmIdempotency, hashPayload, reserveIdempotency } from './idempotency.js'
import { toPurchaseResponse, type PackagePurchaseResponse } from './mapper.js'
import { createPendingReceipt, issueReceipt } from './receipts.js'
import { assertMethodEnabled, loadSettings } from './settings.js'

/**
 * Pacotes pré-pagos (MOD-LEDGER-07).
 *
 * O tutor compra N execuções de um serviço com desconto e as consome ao longo de 90
 * dias. É a métrica de recorrência do produto — e, quando mal feito, a maior fonte de
 * atrito: crédito que expira sem aviso é cliente frustrado a caminho do churn, e por
 * isso `package_expiry_waste_cents` é métrica de **alerta**, não de receita.
 */

/** O que `package_purchases.snapshot` congela no ato da compra (RN-05). */
interface PurchaseSnapshot {
  name: string
  serviceIds: string[]
  credits: number
  priceCents: number
  validityDays: number
}

// ─── Catálogo ────────────────────────────────────────────────────────────────

export async function listPackages(actor: ActorContext, includeInactive: boolean) {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.servicePackage.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    })

    const serviceIds = [...new Set(rows.flatMap((row) => row.serviceIds))]
    const services = await tx.service.findMany({
      where: { id: { in: serviceIds } },
      select: { id: true, name: true },
    })
    const names = new Map(services.map((service) => [service.id, service.name]))

    const counts = await tx.packagePurchase.groupBy({
      by: ['packageId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    })
    const active = new Map(counts.map((row) => [row.packageId, row._count._all]))

    return rows.map((row) => ({
      ...row,
      // Serviço excluído do catálogo deixa o id sem nome; mostrar "(serviço removido)"
      // é mais honesto que esconder a linha e fazer o crédito parecer cobrir menos.
      serviceNames: row.serviceIds.map((id) => names.get(id) ?? '(serviço removido)'),
      activePurchases: active.get(row.id) ?? 0,
    }))
  })
}

export async function createPackage(actor: ActorContext, input: CreateServicePackageInput) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertServicesExist(tx, input.serviceIds)

      const created = await tx.servicePackage.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          serviceIds: input.serviceIds,
          credits: input.credits,
          priceCents: BigInt(input.priceCents),
          validityDays: input.validityDays,
          active: input.active,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.package_created',
        entity: 'service_package',
        entityId: created.id,
        after: { name: input.name, credits: input.credits, priceCents: input.priceCents },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return created
    },
    tenantOptions(actor),
  )

  return result
}

/**
 * Editar o catálogo **não** toca nas compras já feitas.
 *
 * É o que o snapshot garante: quem comprou "4 Banhos por R$ 320" continua com quatro
 * banhos por R$ 320, mesmo que o pacote suba de preço ou passe a cobrir outro serviço
 * amanhã. Desativar também não cancela nada — só tira da vitrine.
 */
export async function updatePackage(
  actor: ActorContext,
  packageId: string,
  input: UpdateServicePackageInput,
) {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.servicePackage.findFirst({ where: { id: packageId } })
      if (!before) throw notFound('Pacote não encontrado')

      if (input.serviceIds) await assertServicesExist(tx, input.serviceIds)

      const updated = await tx.servicePackage.update({
        where: { id: packageId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.serviceIds !== undefined ? { serviceIds: input.serviceIds } : {}),
          ...(input.credits !== undefined ? { credits: input.credits } : {}),
          ...(input.priceCents !== undefined ? { priceCents: BigInt(input.priceCents) } : {}),
          ...(input.validityDays !== undefined ? { validityDays: input.validityDays } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.package_updated',
        entity: 'service_package',
        entityId: packageId,
        before: { name: before.name, priceCents: Number(before.priceCents), active: before.active },
        after: { name: updated.name, priceCents: Number(updated.priceCents), active: updated.active },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return updated
    },
    tenantOptions(actor),
  )
}

async function assertServicesExist(tx: TenantTransaction, serviceIds: string[]): Promise<void> {
  const found = await tx.service.findMany({
    where: { id: { in: serviceIds } },
    select: { id: true },
  })
  if (found.length === serviceIds.length) return

  const missing = serviceIds.filter((id) => !found.some((service) => service.id === id))
  throw notFound(`Serviço não encontrado neste estabelecimento: ${missing.join(', ')}`)
}

// ─── Compra ──────────────────────────────────────────────────────────────────

const PURCHASE_ENDPOINT = 'POST /v1/packages/:id/purchases'

/**
 * AC-01 — a recepção vende o pacote no balcão.
 *
 * **Divergência consciente do PRD.** O AC descreve só um `ledger_entry` de `CREDIT` de
 * R$ 320, o que deixaria o saldo em +32000: o tutor teria quatro banhos *e* R$ 320 de
 * crédito solto. A venda é o **débito** (`PACKAGE_PURCHASE`) e o pagamento é o
 * **crédito** que o quita; o saldo líquido fica zero, as duas linhas aparecem no
 * extrato, e o modelo funciona também quando o petshop vende a prazo.
 */
export async function purchasePackage(
  actor: ActorContext,
  packageId: string,
  input: CreatePackagePurchaseInput,
  capabilities: { canOverridePrice: boolean },
) {
  if (input.priceOverrideCents !== undefined && !capabilities.canOverridePrice) {
    throw forbidden('Somente um administrador pode alterar o preço do pacote na venda')
  }

  const requestHash = hashPayload({ packageId, ...input } as unknown as Record<string, unknown>)

  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const reservation = await reserveIdempotency(
        tx,
        actor.tenantId,
        PURCHASE_ENDPOINT,
        input.idempotencyKey,
        requestHash,
      )
      if (reservation.existingResourceId) {
        return { repeated: true as const, purchaseId: reservation.existingResourceId }
      }

      const pkg = await tx.servicePackage.findFirst({ where: { id: packageId } })
      if (!pkg) throw notFound('Pacote não encontrado')
      if (!pkg.active) throw packageUnavailable('Este pacote não está mais disponível para venda')

      const settings = await loadSettings(tx, actor.tenantId)
      assertMethodEnabled(settings, input.paymentMethod)

      if (input.petId) await assertPetBelongs(tx, input.petId, input.tutorId)

      const priceCents = input.priceOverrideCents ?? Number(pkg.priceCents)
      const snapshot: PurchaseSnapshot = {
        name: pkg.name,
        serviceIds: pkg.serviceIds,
        credits: pkg.credits,
        priceCents,
        validityDays: pkg.validityDays,
      }

      const account = await openAccount(tx, actor.tenantId, input.tutorId)
      const now = new Date()
      const expiresAt = new Date(now.getTime() + pkg.validityDays * 24 * 3_600_000)

      // 1) A venda — o débito.
      const saleEntry = await postEntry(tx, actor, account.balanceCents, {
        accountId: account.id,
        tutorId: input.tutorId,
        direction: 'DEBIT',
        amountCents: priceCents,
        category: 'PACKAGE_PURCHASE',
        description: `${pkg.name} — ${pkg.credits} créditos`.slice(0, 200),
        sourceType: 'PACKAGE',
        petId: input.petId ?? null,
        occurredAt: now,
      })

      // 2) O pagamento — o crédito que quita a venda.
      const paymentEntry = await postEntry(tx, actor, saleEntry.balanceAfterCents, {
        accountId: account.id,
        tutorId: input.tutorId,
        direction: 'CREDIT',
        amountCents: priceCents,
        category: 'PAYMENT',
        description: `Pagamento — ${PAYMENT_METHOD_LABELS[input.paymentMethod]}`,
        sourceType: 'PAYMENT',
        occurredAt: now,
      })

      const payment = await tx.payment.create({
        data: {
          tenantId: actor.tenantId,
          accountId: account.id,
          tutorId: input.tutorId,
          amountCents: BigInt(priceCents),
          method: input.paymentMethod,
          receivedAt: now,
          receivedBy: actor.actorUserId ?? null,
          entryId: paymentEntry.id,
        },
        select: { id: true },
      })

      // Mesmo vínculo do pagamento avulso: o lançamento de crédito aponta para o
      // pagamento que o originou, e é por ele que a tela acha o recibo.
      await tx.ledgerEntry.update({
        where: { id: paymentEntry.id },
        data: { sourceId: payment.id },
      })

      await applyAllocations(
        tx,
        actor.tenantId,
        payment.id,
        [{ debitEntryId: saleEntry.id, amountCents: priceCents }],
        'AUTO_FIFO',
      )

      await tx.ledgerAccount.update({
        where: { id: account.id },
        data: { lastPaymentAt: now },
      })

      const purchase = await tx.packagePurchase.create({
        data: {
          tenantId: actor.tenantId,
          tutorId: input.tutorId,
          packageId,
          petId: input.petId ?? null,
          snapshot: snapshot as unknown as object,
          creditsTotal: pkg.credits,
          purchasedAt: now,
          expiresAt,
          paymentId: payment.id,
          entryId: saleEntry.id,
          createdBy: actor.actorUserId ?? null,
        },
        select: { id: true },
      })

      // A venda de pacote é um pagamento como outro qualquer, e o tutor que entregou
      // R$ 320 no balcão tem o mesmo direito ao comprovante.
      const receipt = await createPendingReceipt(tx, actor.tenantId, {
        paymentId: payment.id,
        tutorId: input.tutorId,
        receivedAt: now,
      })

      await confirmIdempotency(
        tx,
        actor.tenantId,
        PURCHASE_ENDPOINT,
        input.idempotencyKey,
        purchase.id,
      )

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action:
          input.priceOverrideCents !== undefined
            ? 'ledger.package_price_overridden'
            : 'ledger.package_purchased',
        entity: 'package_purchase',
        entityId: purchase.id,
        after: {
          tutorId: input.tutorId,
          packageName: pkg.name,
          creditsTotal: pkg.credits,
          priceCents,
          catalogPriceCents: Number(pkg.priceCents),
          expiresAt: expiresAt.toISOString(),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        repeated: false as const,
        purchaseId: purchase.id,
        saleEntry,
        paymentEntry,
        paymentId: payment.id,
        priceCents,
        purchasedAt: now,
        expiresAt,
        packageName: pkg.name,
        creditsTotal: pkg.credits,
        receiptId: receipt.id,
      }
    },
    tenantOptions(actor),
  )

  if (!result.repeated) {
    await publishPosted(actor, input.tutorId, result.saleEntry)
    await publishPosted(actor, input.tutorId, result.paymentEntry)
    await publishEvent('pagamento.registrado', {
      tenantId: actor.tenantId,
      paymentId: result.paymentId,
      tutorId: input.tutorId,
      amountCents: result.priceCents,
      method: input.paymentMethod,
      receivedAt: result.purchasedAt.toISOString(),
      balanceCents: result.paymentEntry.balanceAfterCents,
    })
    await publishEvent('pacote.comprado', {
      tenantId: actor.tenantId,
      purchaseId: result.purchaseId,
      tutorId: input.tutorId,
      petId: input.petId ?? null,
      packageName: result.packageName,
      creditsTotal: result.creditsTotal,
      expiresAt: result.expiresAt.toISOString(),
    })
    await invalidatePackages(actor.tenantId, input.tutorId)
    await issueReceipt(actor, result.receiptId)
  }

  return { repeated: result.repeated, purchaseId: result.purchaseId }
}

async function assertPetBelongs(
  tx: TenantTransaction,
  petId: string,
  tutorId: string,
): Promise<void> {
  const link = await tx.petTutor.findFirst({
    where: { petId, tutorId },
    select: { id: true },
  })
  if (!link) throw notFound('Este pet não está vinculado a este tutor')
}

// ─── Consumo ─────────────────────────────────────────────────────────────────

interface LockedPurchaseRow {
  id: string
  credits_total: number
  credits_used: number
  expires_at: Date
  snapshot: PurchaseSnapshot
}

/**
 * Acha e trava o pacote que cobre este serviço para este pet.
 *
 * RN-10: o casamento é por `service_id`, **nunca** por equivalência de valor — um
 * pacote de banho não paga uma tosa, ainda que custem o mesmo. RN-11: o
 * `FOR UPDATE` serializa o consumo, e é o que impede `credits_used > credits_total`
 * quando dois atendimentos do mesmo pet terminam ao mesmo tempo com um crédito
 * restante (AC-06). O `chk_credits_bounds` no banco é a segunda linha de defesa.
 *
 * A ordem — o que expira primeiro — é deliberada: gastar antes o crédito que está
 * mais perto de virar pó é o que reduz `package_expiry_waste_cents`.
 */
async function lockCoveringPurchase(
  tx: TenantTransaction,
  tenantId: string,
  tutorId: string,
  petId: string,
  serviceId: string,
  now: Date,
): Promise<LockedPurchaseRow | null> {
  const rows = await tx.$queryRaw<LockedPurchaseRow[]>`
    SELECT id, credits_total, credits_used, expires_at, snapshot
      FROM package_purchases
     WHERE tenant_id = ${tenantId}::uuid
       AND tutor_id = ${tutorId}::uuid
       AND status = 'ACTIVE'
       AND expires_at > ${now}
       AND credits_used < credits_total
       AND (pet_id IS NULL OR pet_id = ${petId}::uuid)
       AND snapshot -> 'serviceIds' @> ${JSON.stringify([serviceId])}::jsonb
     ORDER BY expires_at ASC, purchased_at ASC
     FOR UPDATE
  `
  return rows[0] ?? null
}

export interface RedeemResult {
  purchaseId: string
  entryId: string
  creditsRemaining: number
  expiresAt: Date
  consumed: boolean
}

/**
 * Consome um crédito (AC-02).
 *
 * Idempotente pelo único `(tenant_id, attendance_id, service_id)`: a reentrega do
 * evento encontra o uso já gravado e devolve o mesmo resultado, sem queimar um
 * segundo crédito.
 *
 * O lançamento informativo de **valor zero** existe para o uso aparecer no extrato.
 * Sem ele, o tutor veria um atendimento que simplesmente não gerou linha nenhuma, e
 * "cadê a cobrança do banho de terça?" viraria chamado.
 */
export async function redeemCredit(
  tx: TenantTransaction,
  actor: ActorContext,
  input: {
    tutorId: string
    petId: string
    serviceId: string
    serviceLabel: string
    attendanceId: string
    accountId: string
    balanceCents: number
  },
  now: Date = new Date(),
): Promise<RedeemResult | null> {
  const existing = await tx.packageCreditUsage.findFirst({
    where: { attendanceId: input.attendanceId, serviceId: input.serviceId },
    select: { id: true, purchaseId: true, entryId: true },
  })
  if (existing) {
    const purchase = await tx.packagePurchase.findFirst({
      where: { id: existing.purchaseId },
      select: { creditsTotal: true, creditsUsed: true, expiresAt: true },
    })
    return {
      purchaseId: existing.purchaseId,
      entryId: existing.entryId,
      creditsRemaining: (purchase?.creditsTotal ?? 0) - (purchase?.creditsUsed ?? 0),
      expiresAt: purchase?.expiresAt ?? now,
      consumed: false,
    }
  }

  const purchase = await lockCoveringPurchase(
    tx,
    actor.tenantId,
    input.tutorId,
    input.petId,
    input.serviceId,
    now,
  )
  // AC-04: nenhum pacote cobre este serviço. O débito em dinheiro é gerado
  // normalmente pelo chamador.
  if (!purchase) return null

  const entry = await postEntry(tx, actor, input.balanceCents, {
    accountId: input.accountId,
    tutorId: input.tutorId,
    direction: 'DEBIT',
    amountCents: 0,
    category: 'PACKAGE_REDEMPTION',
    description: `${input.serviceLabel} — pago com ${purchase.snapshot.name}`.slice(0, 200),
    sourceType: 'PACKAGE',
    petId: input.petId,
    occurredAt: now,
  })

  const creditsUsed = purchase.credits_used + 1
  const exhausted = creditsUsed >= purchase.credits_total

  await tx.packagePurchase.update({
    where: { id: purchase.id },
    data: {
      creditsUsed,
      ...(exhausted ? { status: 'CONSUMED' as const } : {}),
    },
  })

  await tx.packageCreditUsage.create({
    data: {
      tenantId: actor.tenantId,
      purchaseId: purchase.id,
      attendanceId: input.attendanceId,
      appointmentId: input.attendanceId,
      serviceId: input.serviceId,
      petId: input.petId,
      entryId: entry.id,
      usedAt: now,
    },
  })

  return {
    purchaseId: purchase.id,
    entryId: entry.id,
    creditsRemaining: purchase.credits_total - creditsUsed,
    expiresAt: purchase.expires_at,
    consumed: true,
  }
}

// ─── Consulta e gestão da compra ─────────────────────────────────────────────

export async function listTutorPackages(
  actor: ActorContext,
  tutorId: string,
): Promise<PackagePurchaseResponse[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.packagePurchase.findMany({
      where: { tutorId },
      orderBy: [{ status: 'asc' }, { expiresAt: 'asc' }],
    })

    const petIds = rows.map((row) => row.petId).filter((id): id is string => id !== null)
    const pets = await tx.pet.findMany({
      where: { id: { in: petIds } },
      select: { id: true, name: true },
    })
    const petNames = new Map(pets.map((pet) => [pet.id, pet.name]))

    const cipher = rows.some((row) => row.suspensionReasonEncrypted)
      ? await openCipher(tx, actor.tenantId)
      : null

    return rows.map((row) =>
      toPurchaseResponse(row, {
        petName: row.petId ? (petNames.get(row.petId) ?? null) : null,
        suspensionReason:
          cipher && row.suspensionReasonEncrypted
            ? cipher.decrypt(row.suspensionReasonEncrypted)
            : null,
      }),
    )
  })
}

/** Uma compra específica, para a resposta do POST e do PATCH. */
export async function findPurchase(
  actor: ActorContext,
  purchaseId: string,
): Promise<PackagePurchaseResponse> {
  return withTenant(actor.tenantId, async (tx) => {
    const purchase = await tx.packagePurchase.findFirst({ where: { id: purchaseId } })
    if (!purchase) throw notFound('Compra de pacote não encontrada')

    const pet = purchase.petId
      ? await tx.pet.findFirst({ where: { id: purchase.petId }, select: { name: true } })
      : null

    return toPurchaseResponse(purchase, { petName: pet?.name ?? null })
  })
}

/**
 * AC-05 — reatribuir, suspender ou cancelar uma compra.
 *
 * Reatribuir a outro pet **reativa** o pacote suspenso: é a decisão que o admin toma
 * quando o pet vinculado foi transferido ou morreu, e exigir dois passos para isso
 * seria só burocracia.
 *
 * Cancelar gera crédito em conta, não dinheiro (§6). Está sob a questão 4 do §11 — o
 * jurídico ainda precisa confirmar se resiste ao CDC quando o cancelamento parte do
 * consumidor.
 */
export async function updatePurchase(
  actor: ActorContext,
  purchaseId: string,
  input: UpdatePackagePurchaseInput,
): Promise<PackagePurchaseResponse> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const purchase = await tx.packagePurchase.findFirst({ where: { id: purchaseId } })
      if (!purchase) throw notFound('Compra de pacote não encontrada')
      if (purchase.status === 'EXPIRED' || purchase.status === 'CANCELLED') {
        throw packageUnavailable(
          `Este pacote está ${purchase.status === 'EXPIRED' ? 'expirado' : 'cancelado'} e não pode mais ser alterado`,
        )
      }

      if (input.petId) await assertPetBelongs(tx, input.petId, purchase.tutorId)

      const cipher = input.reason ? await openCipher(tx, actor.tenantId) : null
      const creditsLeft = purchase.creditsTotal - purchase.creditsUsed

      const nextStatus =
        input.status ??
        // Reatribuir um pacote suspenso o traz de volta: era esse o motivo da suspensão.
        (input.petId && purchase.status === 'SUSPENDED' ? ('ACTIVE' as const) : purchase.status)

      const updated = await tx.packagePurchase.update({
        where: { id: purchaseId },
        data: {
          ...(input.petId !== undefined ? { petId: input.petId } : {}),
          status: nextStatus,
          ...(cipher && input.reason
            ? { suspensionReasonEncrypted: cipher.encrypt(input.reason) }
            : {}),
        },
      })

      // Cancelamento devolve o valor proporcional dos créditos não usados **como
      // crédito em conta** — nunca em dinheiro (§6 e RN-07).
      let refundEntryId: string | null = null
      if (nextStatus === 'CANCELLED' && creditsLeft > 0) {
        const snapshot = purchase.snapshot as unknown as PurchaseSnapshot
        const refundCents = Math.round((snapshot.priceCents * creditsLeft) / purchase.creditsTotal)

        if (refundCents > 0) {
          const account = await openAccount(tx, actor.tenantId, purchase.tutorId)
          const entry = await postEntry(tx, actor, account.balanceCents, {
            accountId: account.id,
            tutorId: purchase.tutorId,
            direction: 'CREDIT',
            amountCents: refundCents,
            category: 'ADJUSTMENT',
            description: `Cancelamento de ${snapshot.name} — ${creditsLeft} crédito(s) devolvido(s)`.slice(0, 200),
            sourceType: 'PACKAGE',
          })
          refundEntryId = entry.id
        }
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action:
          nextStatus === 'CANCELLED'
            ? 'ledger.package_cancelled'
            : input.petId
              ? 'ledger.package_reassigned'
              : 'ledger.package_updated',
        entity: 'package_purchase',
        entityId: purchaseId,
        before: { status: purchase.status, petId: purchase.petId },
        after: { status: nextStatus, petId: updated.petId, reason: input.reason, refundEntryId },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        tutorId: purchase.tutorId,
        purchase: toPurchaseResponse(updated, { suspensionReason: input.reason ?? null }),
      }
    },
    tenantOptions(actor),
  )

  await invalidatePackages(actor.tenantId, result.tutorId)
  return result.purchase
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

interface ExpiringRow {
  id: string
  tenant_id: string
  tutor_id: string
  credits_total: number
  credits_used: number
}

/**
 * AC-03 — o job diário de expiração.
 *
 * RN-08: os créditos remanescentes são perdidos e **nada é devolvido**. É decisão de
 * produto, e é justamente por ser dura que o RN-09 torna o aviso prévio obrigatório:
 * expiração sem aviso é falha de produto, não regra de negócio.
 *
 * Descobrir é cross-tenant (`app_maintenance`), agir nunca é (`withTenant`) — a mesma
 * separação que os jobs da agenda estabeleceram.
 */
export async function expirePackages(now: Date = new Date()): Promise<{ expired: number }> {
  const rows = await getMaintenancePrisma().$queryRaw<ExpiringRow[]>`
    SELECT id, tenant_id, tutor_id, credits_total, credits_used
      FROM package_purchases
     WHERE status = 'ACTIVE' AND expires_at <= ${now}
     ORDER BY expires_at ASC
     LIMIT 500
  `

  let expired = 0
  for (const row of rows) {
    try {
      await withTenant(row.tenant_id, (tx) =>
        tx.packagePurchase.update({ where: { id: row.id }, data: { status: 'EXPIRED' } }),
      )

      const creditsLost = row.credits_total - row.credits_used
      await publishEvent('pacote.expirado', {
        tenantId: row.tenant_id,
        purchaseId: row.id,
        tutorId: row.tutor_id,
        creditsLost,
        expiredAt: now.toISOString(),
      })
      await invalidatePackages(row.tenant_id, row.tutor_id)

      // Métrica de **alerta**: expiração alta significa cliente frustrado e churn
      // adiante, não receita retida.
      recordMetric({
        metric: 'package_expiry_waste_credits',
        tenantId: row.tenant_id,
        value: creditsLost,
        unit: 'count',
      })
      expired += 1
    } catch (error) {
      // Um pacote que não pôde expirar não derruba os outros 499.
      logger.error({ err: error, purchaseId: row.id }, 'falha ao expirar pacote')
    }
  }

  return { expired }
}

/**
 * RN-12 — a anulação do atendimento devolve o crédito.
 *
 * Respeitando a **validade original**: o pacote não ganha sobrevida por causa de um
 * erro nosso, e estender a data aqui seria criar valor do nada.
 *
 * Não há gatilho hoje: `atendimento.anulado` ainda não existe como evento no sistema.
 * A função está escrita e testada esperando por ele.
 */
export async function revertRedemption(
  tx: TenantTransaction,
  tenantId: string,
  attendanceId: string,
): Promise<number> {
  const usages = await tx.packageCreditUsage.findMany({
    where: { attendanceId, revertedAt: null },
    select: { id: true, purchaseId: true },
  })

  const now = new Date()
  for (const usage of usages) {
    await tx.packageCreditUsage.update({
      where: { id: usage.id },
      data: { revertedAt: now },
    })

    const purchase = await tx.packagePurchase.findFirst({
      where: { id: usage.purchaseId },
      select: { creditsUsed: true, expiresAt: true, status: true },
    })
    if (!purchase) continue

    await tx.packagePurchase.update({
      where: { id: usage.purchaseId },
      data: {
        creditsUsed: Math.max(0, purchase.creditsUsed - 1),
        // Só volta a ACTIVE se ainda estiver na validade. Pacote que expirou no
        // meio-tempo continua expirado — a devolução não ressuscita prazo.
        ...(purchase.status === 'CONSUMED' && purchase.expiresAt > now
          ? { status: 'ACTIVE' as const }
          : {}),
      },
    })
  }

  if (usages.length > 0) {
    logger.info({ tenantId, attendanceId, reverted: usages.length }, 'créditos de pacote devolvidos')
  }
  return usages.length
}

/**
 * AC-05 — o pet foi transferido ou morreu.
 *
 * O pacote **permanece com o tutor comprador** (quem pagou) e fica `SUSPENDED` com
 * motivo. Quem decide entre reatribuir a outro pet e deixar expirar é o admin; nunca
 * há reembolso automático. Transferir o pacote junto com o pet seria dar a um
 * terceiro o crédito que outra pessoa comprou.
 */
export async function suspendPurchasesForPet(
  tenantId: string,
  petId: string,
  reason: string,
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const affected = await tx.packagePurchase.findMany({
      where: { petId, status: 'ACTIVE' },
      select: { id: true, tutorId: true },
    })
    if (affected.length === 0) return 0

    const cipher = await openCipher(tx, tenantId)
    await tx.packagePurchase.updateMany({
      where: { id: { in: affected.map((row) => row.id) } },
      data: { status: 'SUSPENDED', suspensionReasonEncrypted: cipher.encrypt(reason) },
    })

    await recordAudit(tx, {
      tenantId,
      action: 'ledger.package_suspended',
      entity: 'pet',
      entityId: petId,
      after: { suspended: affected.length, reason },
    })

    return affected.length
  })
}

/** Usado pelo mapper para reportar o valor pago sem reabrir o snapshot na rota. */
export function snapshotOf(purchase: { snapshot: unknown }): PurchaseSnapshot {
  return purchase.snapshot as PurchaseSnapshot
}

/** Reexportado para a rota montar a mensagem de "sem crédito" com o valor certo. */
export { formatBRL }
