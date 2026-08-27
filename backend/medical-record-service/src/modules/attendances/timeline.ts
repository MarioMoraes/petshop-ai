import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  OPERATIONAL_TIMELINE_KINDS,
  SEVERITY_LABELS,
  TEMPERAMENT_LABELS,
  ALLERGY_TYPE_LABELS,
  ATTENDANCE_TYPE_LABELS,
  type TimelineEntry,
  type TimelineKind,
  type TimelinePage,
  type TimelineQuery,
} from '@petshop/shared-types'
import { notFound } from '../../lib/errors.js'
import { openCipher, type RecordCipher } from '../records/crypto.js'

/**
 * MOD-PRONT-02 — a linha do tempo do pet.
 *
 * Sete origens em ordem cronológica: atendimentos, pesagens, alergias,
 * temperamentos, alertas médicos, fotos e transferências de titularidade. Não há
 * tabela de linha do tempo — ela é **consulta**, e é assim de propósito: uma tabela
 * de eventos exigiria que toda escrita do sistema se lembrasse de alimentá-la, e a
 * primeira que esquecesse produziria um histórico que mente por omissão.
 *
 * O custo disso é a paginação. Ordenar sete conjuntos por data e cortar em 20 exige
 * carregar um pouco mais de cada um do que se devolve — `take: limit + 1` por
 * origem, junta, ordena, corta. Para a escala de um pet (dezenas a centenas de
 * eventos numa vida) isso cabe folgado no SLO de 500ms, e evita o `UNION ALL` em
 * SQL cru, que teria de repetir a política de RLS sete vezes à mão.
 *
 * **O filtro por papel é servidor** (AC-02): quem não tem `record:read` não recebe
 * o clínico, e a diferença é feita antes da consulta, não escondendo no cliente.
 */

export interface TimelineOptions {
  /** `record:read` — o prontuário completo. Sem ele, só o recorte operacional. */
  full: boolean
  query: TimelineQuery
}

export async function getTimeline(
  tenantId: string,
  petId: string,
  options: TimelineOptions,
): Promise<TimelinePage> {
  const { limit, cursor } = options.query
  const before = decodeCursor(cursor)

  const allowed = new Set<TimelineKind>(
    options.full
      ? (options.query.kinds ?? [
          'ATTENDANCE',
          'WEIGHT',
          'ALLERGY',
          'TEMPERAMENT',
          'MEDICAL_ALERT',
          'PHOTO',
          'TRANSFER',
        ])
      : (options.query.kinds ?? OPERATIONAL_TIMELINE_KINDS).filter((kind) =>
          OPERATIONAL_TIMELINE_KINDS.includes(kind),
        ),
  )

  return withTenant(tenantId, async (tx) => {
    const pet = await tx.pet.findFirst({ where: { id: petId }, select: { id: true } })
    if (!pet) throw notFound('Pet não encontrado')

    const cipher = await openCipher(tx, tenantId)
    const take = limit + 1

    const groups = await Promise.all([
      allowed.has('ATTENDANCE') ? attendances(tx, petId, before, take, options.full) : [],
      allowed.has('WEIGHT') ? weights(tx, petId, before, take) : [],
      allowed.has('ALLERGY') ? allergies(tx, petId, before, take, cipher, options.full) : [],
      allowed.has('TEMPERAMENT') ? temperaments(tx, petId, before, take, cipher) : [],
      allowed.has('MEDICAL_ALERT') ? medicalAlerts(tx, petId, before, take, cipher) : [],
      allowed.has('PHOTO') ? photos(tx, petId, before, take) : [],
      allowed.has('TRANSFER') ? transfers(tx, petId, before, take) : [],
    ])

    const merged = groups
      .flat()
      .sort((a, b) => compareDesc(a, b))
      .slice(0, take)

    const hasMore = merged.length > limit
    const page = hasMore ? merged.slice(0, limit) : merged
    const last = page.at(-1)

    return {
      entries: page,
      nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null,
    }
  })
}

// ─── Origens ─────────────────────────────────────────────────────────────────

async function attendances(
  tx: TenantTransaction,
  petId: string,
  before: CursorPosition | null,
  take: number,
  full: boolean,
): Promise<TimelineEntry[]> {
  const rows = await tx.attendance.findMany({
    where: {
      petId,
      // O rascunho é o atendimento em curso: aparece na tela do dia, não no
      // histórico. Mostrá-lo aqui encheria a linha do tempo de registros vazios.
      status: { not: 'DRAFT' },
      ...whereBefore(before, 'startedAt'),
    },
    include: { items: { select: { label: true } }, notes: { select: { kind: true } } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take,
  })

  return rows.map((row) => ({
    kind: 'ATTENDANCE' as const,
    id: row.id,
    occurredAt: row.startedAt.toISOString(),
    title: ATTENDANCE_TYPE_LABELS[row.type as keyof typeof ATTENDANCE_TYPE_LABELS] ?? 'Atendimento',
    detail: row.items.map((item) => item.label).join(', ') || null,
    status: row.status,
    severity: null,
    meta: {
      appointmentId: row.appointmentId,
      performedBy: row.performedBy,
      version: row.version,
      addendumCount: row.notes.filter((note) => note.kind === 'ADDENDUM').length,
      voidReason: row.voidReason,
      // O valor é do prontuário completo: o banhista vê o que fez, não quanto custou.
      ...(full ? { totalCents: Number(row.totalCents) } : {}),
    },
  }))
}

async function weights(
  tx: TenantTransaction,
  petId: string,
  before: CursorPosition | null,
  take: number,
): Promise<TimelineEntry[]> {
  const rows = await tx.petWeight.findMany({
    where: { petId, ...whereBefore(before, 'measuredAt') },
    orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
    take,
  })

  return rows.map((row) => ({
    kind: 'WEIGHT' as const,
    id: row.id,
    occurredAt: row.measuredAt.toISOString(),
    title: `Pesagem — ${Number(row.weightKg).toFixed(2).replace('.', ',')} kg`,
    detail: null,
    status: null,
    severity: null,
    meta: { weightKg: Number(row.weightKg), attendanceId: row.attendanceId },
  }))
}

async function allergies(
  tx: TenantTransaction,
  petId: string,
  before: CursorPosition | null,
  take: number,
  cipher: RecordCipher,
  full: boolean,
): Promise<TimelineEntry[]> {
  const rows = await tx.allergy.findMany({
    where: { petId, ...whereBefore(before, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })

  return rows.map((row) => ({
    kind: 'ALLERGY' as const,
    id: row.id,
    occurredAt: row.createdAt.toISOString(),
    title: `Alergia — ${row.label}`,
    // A reação é descrição clínica: fica com quem tem `record:read`. O banhista
    // precisa saber que existe alergia e o quanto ela é grave, não o quadro.
    detail: full && row.reactionEncrypted ? cipher.decrypt(row.reactionEncrypted) : null,
    status: row.active ? 'ACTIVE' : 'INACTIVE',
    severity: row.severity as TimelineEntry['severity'],
    meta: {
      type: ALLERGY_TYPE_LABELS[row.type as keyof typeof ALLERGY_TYPE_LABELS] ?? row.type,
      severityLabel: SEVERITY_LABELS[row.severity as keyof typeof SEVERITY_LABELS],
      active: row.active,
    },
  }))
}

async function temperaments(
  tx: TenantTransaction,
  petId: string,
  before: CursorPosition | null,
  take: number,
  cipher: RecordCipher,
): Promise<TimelineEntry[]> {
  const rows = await tx.temperament.findMany({
    where: { petId, ...whereBefore(before, 'observedAt') },
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    take,
  })

  return rows.map((row) => ({
    kind: 'TEMPERAMENT' as const,
    id: row.id,
    occurredAt: row.observedAt.toISOString(),
    title: `Temperamento — ${TEMPERAMENT_LABELS[row.classification as keyof typeof TEMPERAMENT_LABELS] ?? row.classification}`,
    // O manejo é informação de segurança: vai para todo mundo que encosta no pet.
    detail: row.notesEncrypted ? cipher.decrypt(row.notesEncrypted) : null,
    status: row.isCurrent ? 'CURRENT' : 'SUPERSEDED',
    severity: null,
    meta: {
      classification: row.classification,
      requiresMuzzle: row.requiresMuzzle,
      requiresTwoHandlers: row.requiresTwoHandlers,
      contexts: row.contexts,
    },
  }))
}

async function medicalAlerts(
  tx: TenantTransaction,
  petId: string,
  before: CursorPosition | null,
  take: number,
  cipher: RecordCipher,
): Promise<TimelineEntry[]> {
  const rows = await tx.medicalAlert.findMany({
    where: { petId, ...whereBefore(before, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })

  return rows.map((row) => ({
    kind: 'MEDICAL_ALERT' as const,
    id: row.id,
    occurredAt: row.createdAt.toISOString(),
    title: `Alerta médico — ${row.condition}`,
    detail: row.instructionsEncrypted ? cipher.decrypt(row.instructionsEncrypted) : null,
    status: row.active ? 'ACTIVE' : 'INACTIVE',
    severity: row.severity as TimelineEntry['severity'],
    meta: { active: row.active },
  }))
}

async function photos(
  tx: TenantTransaction,
  petId: string,
  before: CursorPosition | null,
  take: number,
): Promise<TimelineEntry[]> {
  const rows = await tx.petPhoto.findMany({
    where: { petId, deletedAt: null, ...whereBefore(before, 'takenAt') },
    orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
    take,
  })

  return rows.map((row) => ({
    kind: 'PHOTO' as const,
    id: row.id,
    occurredAt: row.takenAt.toISOString(),
    title: row.attendancePhase === 'BEFORE' ? 'Foto — antes' : row.attendancePhase === 'AFTER' ? 'Foto — depois' : 'Foto',
    detail: row.caption,
    status: null,
    severity: null,
    // A URL não vem daqui: o álbum do MOD-PET assina por 15 minutos na leitura, e
    // guardar ou repassar link assinado neste payload furaria essa regra.
    meta: { attendanceId: row.attendanceId, phase: row.attendancePhase, source: row.source },
  }))
}

async function transfers(
  tx: TenantTransaction,
  petId: string,
  before: CursorPosition | null,
  take: number,
): Promise<TimelineEntry[]> {
  const rows = await tx.petTransferLog.findMany({
    where: { petId, ...whereBefore(before, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })

  return rows.map((row) => ({
    kind: 'TRANSFER' as const,
    id: row.id,
    occurredAt: row.createdAt.toISOString(),
    title: 'Transferência de titularidade',
    detail: row.notes,
    status: null,
    severity: null,
    // RN-14: o prontuário não se move nem se esconde na transferência — ela é só
    // mais um evento da vida do animal.
    meta: { reason: row.reason, fromTutorId: row.fromTutorId, toTutorId: row.toTutorId },
  }))
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

interface CursorPosition {
  occurredAt: Date
  id: string
}

/**
 * Opaco por fora, `occurredAt|id` por dentro.
 *
 * O par é necessário porque a data sozinha empata: duas fotos enviadas no mesmo
 * segundo repetiriam ou sumiriam entre páginas. O `id` desempata de forma estável.
 */
function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(`${occurredAt}|${id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): CursorPosition | null {
  if (!cursor) return null
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (!at || !id) return null
  const occurredAt = new Date(at)
  return Number.isNaN(occurredAt.getTime()) ? null : { occurredAt, id }
}

/**
 * "Estritamente antes do cursor", com o desempate por id na borda.
 *
 * O `OR` existe para o empate exato de data: sem ele, um evento com a mesma data do
 * cursor e id menor jamais apareceria — cairia fora do `lt` e fora da página anterior.
 */
function whereBefore(before: CursorPosition | null, field: string): Record<string, unknown> {
  if (!before) return {}
  return {
    OR: [
      { [field]: { lt: before.occurredAt } },
      { [field]: before.occurredAt, id: { lt: before.id } },
    ],
  }
}

function compareDesc(a: TimelineEntry, b: TimelineEntry): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1
  return a.id < b.id ? 1 : -1
}
