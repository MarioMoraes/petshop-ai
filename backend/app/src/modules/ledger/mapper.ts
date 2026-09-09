import type {
  EntryCategory,
  EntryDirection,
  EntrySourceType,
  PaymentMethod,
  PaymentStatus,
  PurchaseStatus,
} from '@petshop/shared-types'

/**
 * Tradução linha → resposta.
 *
 * Síncrono de propósito: nenhum mapper faz I/O. E as respostas são **declaradas**, não
 * inferidas — sem a anotação o TypeScript tenta nomear os tipos gerados do Prisma pelo
 * caminho dentro de `node_modules` e recusa emitir (TS2742). Declarar também congela o
 * contrato: mudar uma coluna deixa de mudar a API por acidente.
 *
 * Aqui há um segundo motivo, que é o de segurança: `internalNotes` só aparece se
 * `includeInternal` for verdadeiro. **A filtragem é no servidor** (AC-03 de
 * MOD-LEDGER-06) — deixar o campo sair e o cliente esconder seria o mesmo que não
 * escondê-lo.
 */

export interface LedgerEntryResponse {
  id: string
  tutorId: string
  petId: string | null
  direction: EntryDirection
  amountCents: number
  signedAmountCents: number
  balanceAfterCents: number
  category: EntryCategory
  description: string
  internalNotes?: string | null
  sourceType: EntrySourceType
  sourceId: string | null
  occurredAt: string
  postedAt: string
  status: 'POSTED' | 'REVERSED'
  settledCents: number
  reversedByEntryId: string | null
  reversesEntryId: string | null
}

interface EntryLike {
  id: string
  tutorId?: string
  tutor_id?: string
  petId?: string | null
  pet_id?: string | null
  direction: string
  amountCents?: bigint
  amount_cents?: bigint
  signedAmountCents?: bigint | null
  signed_amount_cents?: bigint | null
  balanceAfterCents?: bigint
  balance_after_cents?: bigint
  category: string
  description: string
  sourceType?: string
  source_type?: string
  sourceId?: string | null
  source_id?: string | null
  occurredAt?: Date
  occurred_at?: Date
  postedAt?: Date
  posted_at?: Date
  status: string
  settledCents?: bigint
  settled_cents?: bigint
  reversedByEntryId?: string | null
  reversed_by_entry_id?: string | null
  reversesEntryId?: string | null
  reverses_entry_id?: string | null
}

/**
 * Aceita tanto a linha do Prisma (camelCase) quanto a do `$queryRaw` (snake_case).
 *
 * O extrato usa SQL cru — o `openingBalance` por lookup e os totais com `FILTER` não
 * cabem no query builder — enquanto o detalhe de um lançamento vem pelo Prisma. Ter um
 * mapper só é o que garante que as duas rotas devolvam exatamente o mesmo formato.
 */
export function toEntryResponse(
  row: EntryLike,
  options: { internalNotes?: string | null; includeInternal: boolean },
): LedgerEntryResponse {
  const amountCents = Number(row.amountCents ?? row.amount_cents ?? 0)
  const direction = row.direction as EntryDirection

  return {
    id: row.id,
    tutorId: (row.tutorId ?? row.tutor_id) as string,
    petId: row.petId ?? row.pet_id ?? null,
    direction,
    amountCents,
    signedAmountCents: Number(
      row.signedAmountCents ??
        row.signed_amount_cents ??
        (direction === 'CREDIT' ? amountCents : -amountCents),
    ),
    balanceAfterCents: Number(row.balanceAfterCents ?? row.balance_after_cents ?? 0),
    category: row.category as EntryCategory,
    description: row.description,
    ...(options.includeInternal ? { internalNotes: options.internalNotes ?? null } : {}),
    sourceType: (row.sourceType ?? row.source_type) as EntrySourceType,
    sourceId: row.sourceId ?? row.source_id ?? null,
    occurredAt: (row.occurredAt ?? row.occurred_at ?? new Date()).toISOString(),
    postedAt: (row.postedAt ?? row.posted_at ?? new Date()).toISOString(),
    status: row.status as 'POSTED' | 'REVERSED',
    settledCents: Number(row.settledCents ?? row.settled_cents ?? 0),
    reversedByEntryId: row.reversedByEntryId ?? row.reversed_by_entry_id ?? null,
    reversesEntryId: row.reversesEntryId ?? row.reverses_entry_id ?? null,
  }
}

export interface LedgerAccountResponse {
  tutorId: string
  balanceCents: number
  currency: string
  openDebitsCents: number
  openDebitsCount: number
  oldestOpenDebitAt: string | null
  lastEntryAt: string | null
  lastPaymentAt: string | null
  needsReview: boolean
}

export function toAccountResponse(
  tutorId: string,
  summary: {
    balanceCents: number
    currency: string
    openDebitsCents: number
    openDebitsCount: number
    oldestOpenDebitAt: Date | null
    lastEntryAt: Date | null
    lastPaymentAt: Date | null
    needsReview: boolean
  },
): LedgerAccountResponse {
  return {
    tutorId,
    balanceCents: summary.balanceCents,
    currency: summary.currency,
    openDebitsCents: summary.openDebitsCents,
    openDebitsCount: summary.openDebitsCount,
    oldestOpenDebitAt: summary.oldestOpenDebitAt?.toISOString() ?? null,
    lastEntryAt: summary.lastEntryAt?.toISOString() ?? null,
    lastPaymentAt: summary.lastPaymentAt?.toISOString() ?? null,
    needsReview: summary.needsReview,
  }
}

export interface PaymentAllocationResponse {
  debitEntryId: string
  debitDescription: string
  amountCents: number
  allocatedBy: 'AUTO_FIFO' | 'MANUAL'
  reversedAt: string | null
}

export interface PaymentResponse {
  id: string
  tutorId: string
  amountCents: number
  allocatedCents: number
  method: PaymentMethod
  receivedAt: string
  receivedBy: string | null
  entryId: string
  status: PaymentStatus
  reversalReason: string | null
  notes?: string | null
  proofUrl?: string | null
  allocations: PaymentAllocationResponse[]
  createdAt: string
}

interface PaymentRowLike {
  id: string
  tutorId: string
  amountCents: bigint
  allocatedCents: bigint
  method: string
  receivedAt: Date
  receivedBy: string | null
  entryId: string
  status: string
  reversalReason: string | null
  createdAt: Date
  allocations: {
    debitEntryId: string
    amountCents: bigint
    allocatedBy: string
    reversedAt: Date | null
    debitEntry: { description: string }
  }[]
}

export function toPaymentResponse(
  row: PaymentRowLike,
  decrypted?: { notes: string | null; proofUrl: string | null },
): PaymentResponse {
  return {
    id: row.id,
    tutorId: row.tutorId,
    amountCents: Number(row.amountCents),
    allocatedCents: Number(row.allocatedCents),
    method: row.method as PaymentMethod,
    receivedAt: row.receivedAt.toISOString(),
    receivedBy: row.receivedBy,
    entryId: row.entryId,
    status: row.status as PaymentStatus,
    reversalReason: row.reversalReason,
    // Ausentes na listagem de propósito: campo livre com risco de PII não vai na
    // lista, só no detalhe. Mesma regra que a agenda aplica a `notes`.
    ...(decrypted ? { notes: decrypted.notes, proofUrl: decrypted.proofUrl } : {}),
    allocations: row.allocations.map((allocation) => ({
      debitEntryId: allocation.debitEntryId,
      debitDescription: allocation.debitEntry.description,
      amountCents: Number(allocation.amountCents),
      allocatedBy: allocation.allocatedBy as 'AUTO_FIFO' | 'MANUAL',
      reversedAt: allocation.reversedAt?.toISOString() ?? null,
    })),
    createdAt: row.createdAt.toISOString(),
  }
}

export interface ServicePackageResponse {
  id: string
  name: string
  serviceIds: string[]
  serviceNames: string[]
  credits: number
  priceCents: number
  validityDays: number
  active: boolean
  activePurchases: number
}

export function toPackageResponse(row: {
  id: string
  name: string
  serviceIds: string[]
  serviceNames: string[]
  credits: number
  priceCents: bigint
  validityDays: number
  active: boolean
  activePurchases: number
}): ServicePackageResponse {
  return {
    id: row.id,
    name: row.name,
    serviceIds: row.serviceIds,
    serviceNames: row.serviceNames,
    credits: row.credits,
    priceCents: Number(row.priceCents),
    validityDays: row.validityDays,
    active: row.active,
    activePurchases: row.activePurchases,
  }
}

export interface PackagePurchaseResponse {
  id: string
  packageId: string
  tutorId: string
  petId: string | null
  petName: string | null
  name: string
  serviceIds: string[]
  creditsTotal: number
  creditsUsed: number
  creditsRemaining: number
  pricePaidCents: number
  purchasedAt: string
  expiresAt: string
  status: PurchaseStatus
  suspensionReason?: string | null
}

export function toPurchaseResponse(
  row: {
    id: string
    packageId: string
    tutorId: string
    petId: string | null
    snapshot: unknown
    creditsTotal: number
    creditsUsed: number
    purchasedAt: Date
    expiresAt: Date
    status: string
  },
  extra: { petName?: string | null; suspensionReason?: string | null } = {},
): PackagePurchaseResponse {
  const snapshot = row.snapshot as {
    name: string
    serviceIds: string[]
    priceCents: number
  }

  return {
    id: row.id,
    packageId: row.packageId,
    tutorId: row.tutorId,
    petId: row.petId,
    petName: extra.petName ?? null,
    // Do snapshot, nunca do catálogo: quem comprou "4 Banhos por R$ 320" continua
    // vendo isso mesmo que o pacote tenha subido de preço depois (RN-05).
    name: snapshot.name,
    serviceIds: snapshot.serviceIds,
    creditsTotal: row.creditsTotal,
    creditsUsed: row.creditsUsed,
    creditsRemaining: row.creditsTotal - row.creditsUsed,
    pricePaidCents: snapshot.priceCents,
    purchasedAt: row.purchasedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.status as PurchaseStatus,
    ...(extra.suspensionReason !== undefined ? { suspensionReason: extra.suspensionReason } : {}),
  }
}
