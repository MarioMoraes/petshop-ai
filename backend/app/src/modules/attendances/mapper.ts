import type { Attendance, AttendanceItem, AttendanceNote, ProductUsed } from '@petshop/shared-types'
import type { RecordCipher } from '../records/crypto.js'
import { decryptOptional } from '../records/crypto.js'

/**
 * Linha do banco → contrato do §5.
 *
 * Dois cuidados que não são cosméticos. O primeiro: `BigInt` sai como `number` — o
 * JSON de resposta não transporta `BigInt`, e um `JSON.stringify` sobre ele estoura
 * em vez de degradar. O segundo: `editable` é **derivado aqui**, e não guardado, para
 * que a resposta nunca diga que dá para editar um registro cuja janela fechou
 * enquanto a tela estava aberta.
 */

interface AttendanceRow {
  id: string
  petId: string
  tutorId: string
  appointmentId: string | null
  type: string
  origin: string
  performedBy: string
  startedAt: Date
  finishedAt: Date | null
  observationsEncrypted: string | null
  weightKg: unknown
  status: string
  voidReason: string | null
  voidedAt: Date | null
  editableUntil: Date | null
  version: number
  totalCents: bigint
  createdAt: Date
}

interface ItemRow {
  id: string
  serviceId: string
  label: string
  executedBy: string
  unitPriceCents: bigint
  quantity: number
  totalPriceCents: bigint
  notes: string | null
  productsUsed: unknown
}

interface NoteRow {
  id: string
  kind: string
  visibility: string
  bodyEncrypted: string
  version: number
  authorId: string | null
  createdAt: Date
}

export function toAttendance(
  row: AttendanceRow & { items?: ItemRow[]; notes?: NoteRow[] },
  cipher: RecordCipher,
  now = new Date(),
): Attendance {
  return {
    id: row.id,
    petId: row.petId,
    tutorId: row.tutorId,
    appointmentId: row.appointmentId,
    type: row.type as Attendance['type'],
    origin: row.origin as Attendance['origin'],
    performedBy: row.performedBy,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    observations: decryptOptional(cipher, row.observationsEncrypted),
    weightKg: row.weightKg === null ? null : Number(row.weightKg),
    status: row.status as Attendance['status'],
    voidReason: row.voidReason,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    editableUntil: row.editableUntil?.toISOString() ?? null,
    editable: isEditable(row, now),
    version: row.version,
    totalCents: Number(row.totalCents),
    items: (row.items ?? []).map(toAttendanceItem),
    notes: (row.notes ?? []).map((note) => toAttendanceNote(note, cipher)),
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * RN-05: o rascunho é sempre editável — o pet ainda está no salão. O concluído é
 * editável até `editable_until`. O anulado, nunca: corrigir um registro que já foi
 * declarado errado é reabrir a questão pelo lado errado.
 */
export function isEditable(
  row: Pick<AttendanceRow, 'status' | 'editableUntil'>,
  now = new Date(),
): boolean {
  if (row.status === 'DRAFT') return true
  if (row.status !== 'COMPLETED') return false
  return row.editableUntil !== null && now <= row.editableUntil
}

export function toAttendanceItem(row: ItemRow): AttendanceItem {
  return {
    id: row.id,
    serviceId: row.serviceId,
    label: row.label,
    executedBy: row.executedBy,
    unitPriceCents: Number(row.unitPriceCents),
    quantity: row.quantity,
    totalPriceCents: Number(row.totalPriceCents),
    notes: row.notes,
    productsUsed: toProductsUsed(row.productsUsed),
  }
}

export function toAttendanceNote(row: NoteRow, cipher: RecordCipher): AttendanceNote {
  return {
    id: row.id,
    kind: row.kind as AttendanceNote['kind'],
    visibility: row.visibility as AttendanceNote['visibility'],
    body: cipher.decrypt(row.bodyEncrypted),
    version: row.version,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  }
}

/** JSONB é `unknown` para o Prisma; o formato é `[{ name, batch }]` (RN-11). */
function toProductsUsed(value: unknown): ProductUsed[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const { name, batch, productId, lotId, quantity } = entry as Record<string, unknown>
    if (typeof name !== 'string') return []
    // A ligação com o estoque (MOD-ESTOQUE-07) volta junto: sem ela a tela não sabe qual
    // lote foi usado, e a próxima edição refaria a baixa sobre uma lista sem lote.
    return [
      {
        name,
        ...(typeof batch === 'string' ? { batch } : {}),
        ...(typeof productId === 'string' ? { productId } : {}),
        ...(typeof lotId === 'string' ? { lotId } : {}),
        ...(typeof quantity === 'string' ? { quantity } : {}),
      },
    ]
  })
}
