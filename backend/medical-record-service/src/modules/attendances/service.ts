import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  RECORD_ROUTING_KEYS,
  type AddendumInput,
  type Attendance,
  type CreateAttendanceInput,
  type ListAttendancesQuery,
  type OperationalNoteInput,
  type UpdateAttendanceInput,
  type VoidAttendanceInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { alreadyRegistered, forbidden, immutable, invalid, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { recordMetric } from '../../lib/logger.js'
import { tenantOptions, type ActorContext } from '../records/actor.js'
import { encryptOptional, openCipher } from '../records/crypto.js'
import { invalidateSummary } from './cache.js'
import { isEditable, toAttendance } from './mapper.js'

/**
 * MOD-PRONT-01/09/10 — o atendimento.
 *
 * Este arquivo é tudo o que acontece **depois** que o registro existe. Quem o cria é
 * `consumers.ts`, a partir do check-in e do check-out da agenda: o atendimento é um
 * fato da operação, e a operação acontece no balcão, não num formulário.
 *
 * A regra que governa o módulo é a RN-05, e ela tem uma forma incomum. Não é "não
 * pode mudar" — é "depois de 24h, mudar é acrescentar". O registro original nunca é
 * sobrescrito; a correção entra como adendo versionado, visível embaixo dele. Um
 * prontuário que se deixa reescrever não prova nada seis meses depois, e um que não
 * se deixa corrigir de forma nenhuma obriga a equipe a mentir na primeira vez.
 */

const ATTENDANCE_INCLUDE = {
  items: { orderBy: { createdAt: 'asc' } },
  notes: { orderBy: { createdAt: 'asc' } },
} as const

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function getAttendance(actor: ActorContext, id: string): Promise<Attendance> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.attendance.findFirst({ where: { id }, include: ATTENDANCE_INCLUDE })
    if (!row) throw notFound('Atendimento não encontrado')

    const cipher = await openCipher(tx, actor.tenantId)
    return toAttendance(row, cipher)
  })
}

export interface AttendancePage {
  attendances: Attendance[]
  nextCursor: string | null
}

/**
 * Listagem por período, pet ou profissional.
 *
 * O cursor é o `id` da última linha, e a ordenação é `started_at DESC, id DESC` —
 * o par é necessário porque dois atendimentos do mesmo minuto empatariam no primeiro
 * campo e a paginação repetiria ou pularia linhas.
 */
export async function listAttendances(
  actor: ActorContext,
  query: ListAttendancesQuery,
): Promise<AttendancePage> {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.attendance.findMany({
      where: {
        ...(query.petId ? { petId: query.petId } : {}),
        ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
        ...(query.professionalId ? { performedBy: query.professionalId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.from || query.to
          ? {
              startedAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      include: ATTENDANCE_INCLUDE,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const cipher = await openCipher(tx, actor.tenantId)

    return {
      attendances: page.map((row) => toAttendance(row, cipher)),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    }
  })
}

// ─── Correção dentro da janela (MOD-PRONT-09, AC-01) ─────────────────────────

/**
 * A edição direta, permitida enquanto `editable_until` não passou.
 *
 * O diff vai para a auditoria porque a janela de 24h não é licença para reescrever
 * em silêncio: dentro dela a correção é aplicada no registro, mas o que havia antes
 * continua recuperável na trilha.
 */
export async function updateAttendance(
  actor: ActorContext,
  id: string,
  input: UpdateAttendanceInput,
  isAdmin: boolean,
): Promise<Attendance> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const current = await loadForWrite(tx, id)
      if (current.status === 'VOIDED') {
        throw invalid('Atendimento anulado não é editado — registre um novo no lugar certo')
      }
      if (!isEditable(current)) throw immutable()
      await assertCanWrite(tx, actor, current, isAdmin)

      const cipher = await openCipher(tx, actor.tenantId)

      if (input.items) {
        const known = new Set(current.items.map((item) => item.id))
        for (const patch of input.items) {
          if (!known.has(patch.id)) throw notFound('Item não pertence a este atendimento')
          await tx.attendanceItem.update({
            where: { id: patch.id },
            data: {
              ...(patch.executedBy ? { executedBy: patch.executedBy } : {}),
              ...(patch.notes === undefined ? {} : { notes: patch.notes ?? null }),
              ...(patch.productsUsed ? { productsUsed: patch.productsUsed } : {}),
            },
          })
        }
      }

      const updated = await tx.attendance.update({
        where: { id },
        data: {
          ...(input.observations === undefined
            ? {}
            : { observationsEncrypted: encryptOptional(cipher, input.observations) }),
          ...(input.type ? { type: input.type } : {}),
        },
        include: ATTENDANCE_INCLUDE,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'attendance.updated',
        entity: 'attendance',
        entityId: id,
        // O texto clínico não entra na trilha (`sensitiveKeys` de `lib/audit.ts`):
        // o que se audita é que houve correção e em quais campos, não o conteúdo.
        before: { type: current.type, hadObservations: current.observationsEncrypted !== null },
        after: {
          type: updated.type,
          hadObservations: updated.observationsEncrypted !== null,
          changedItems: input.items?.map((item) => item.id) ?? [],
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { row: updated, petId: updated.petId, cipher }
    },
    tenantOptions(actor),
  )

  await invalidateSummary(actor.tenantId, result.petId)
  return toAttendance(result.row, result.cipher)
}

// ─── Adendo (MOD-PRONT-09, AC-02) ────────────────────────────────────────────

/**
 * A correção depois das 24h.
 *
 * Só o `version` do atendimento muda — é o contador que a linha do tempo exibe como
 * "v2". O trigger do banco permite exatamente essa escrita e nenhuma outra fora da
 * janela; ver a migration `20260827120000_mod_pront_atendimento`.
 */
export async function addAddendum(
  actor: ActorContext,
  id: string,
  input: AddendumInput,
  isAdmin: boolean,
): Promise<Attendance> {
  return appendNote(actor, id, {
    kind: 'ADDENDUM',
    body: input.body,
    visibility: input.visibility,
    bumpVersion: true,
    action: 'attendance.addendum_added',
    // §9: o adendo é do ADMIN, do VET e do autor. O veterinário chega aqui por
    // `record:write`, a mesma chave que identifica o administrador na rota.
    isAdmin,
  })
}

/**
 * MOD-PRONT-10 — a nota rápida de quem está com o pet na mão.
 *
 * Não incrementa versão: não é correção de um registro fechado, é o próprio registro
 * sendo escrito enquanto acontece. Por isso também não exige janela — o rascunho
 * está aberto justamente para isto.
 */
export async function addOperationalNote(
  actor: ActorContext,
  id: string,
  input: OperationalNoteInput,
): Promise<Attendance> {
  return appendNote(actor, id, {
    kind: 'OPERATIONAL',
    body: input.body,
    visibility: input.visibility,
    bumpVersion: false,
    action: 'attendance.note_added',
    // A nota operacional é de quem está com o pet na mão — `record:write_notes`
    // basta, e o banhista não é autor de nada no sentido do §9.
    isAdmin: true,
  })
}

interface AppendNoteOptions {
  kind: 'ADDENDUM' | 'OPERATIONAL'
  body: string
  visibility: 'INTERNAL' | 'TUTOR_VISIBLE'
  bumpVersion: boolean
  action: string
  isAdmin: boolean
}

async function appendNote(
  actor: ActorContext,
  id: string,
  options: AppendNoteOptions,
): Promise<Attendance> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const current = await loadForWrite(tx, id)
      if (current.status === 'VOIDED') {
        throw invalid('Atendimento anulado não recebe adendo')
      }
      if (options.kind === 'OPERATIONAL' && current.status !== 'DRAFT') {
        throw immutable('O atendimento já foi concluído — registre um adendo')
      }
      await assertCanWrite(tx, actor, current, options.isAdmin)

      const cipher = await openCipher(tx, actor.tenantId)
      const version = current.version + (options.bumpVersion ? 1 : 0)

      await tx.attendanceNote.create({
        data: {
          tenantId: actor.tenantId,
          attendanceId: id,
          kind: options.kind,
          visibility: options.visibility,
          bodyEncrypted: cipher.encrypt(options.body),
          version,
          authorId: actor.actorUserId ?? null,
        },
      })

      const updated = options.bumpVersion
        ? await tx.attendance.update({
            where: { id },
            data: { version },
            include: ATTENDANCE_INCLUDE,
          })
        : await tx.attendance.findFirstOrThrow({
            where: { id },
            include: ATTENDANCE_INCLUDE,
          })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: options.action,
        entity: 'attendance',
        entityId: id,
        after: { version, visibility: options.visibility, length: options.body.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { row: updated, cipher, petId: updated.petId }
    },
    tenantOptions(actor),
  )

  await invalidateSummary(actor.tenantId, result.petId)
  return toAttendance(result.row, result.cipher)
}

// ─── Anulação (MOD-PRONT-09, AC-03) ──────────────────────────────────────────

/**
 * O registro **não é excluído**: vai a `VOIDED` com motivo, continua na linha do
 * tempo riscado, e o débito correspondente é estornado por contrapartida no ledger —
 * nunca por edição do lançamento.
 *
 * O estorno é assíncrono, pelo `atendimento.anulado`, e é o mesmo caminho pelo qual
 * o débito nasceu. Corrigir dinheiro pelo mesmo mecanismo que o criou é o que mantém
 * as duas metades explicáveis uma pela outra.
 */
export async function voidAttendance(
  actor: ActorContext,
  id: string,
  input: VoidAttendanceInput,
): Promise<Attendance> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const current = await loadForWrite(tx, id)
      if (current.status === 'VOIDED') {
        throw invalid('Este atendimento já foi anulado')
      }

      const updated = await tx.attendance.update({
        where: { id },
        data: {
          status: 'VOIDED',
          voidReason: input.reason,
          voidedBy: actor.actorUserId ?? null,
          voidedAt: new Date(),
        },
        include: ATTENDANCE_INCLUDE,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'attendance.voided',
        entity: 'attendance',
        entityId: id,
        before: { status: current.status, totalCents: Number(current.totalCents) },
        after: { status: 'VOIDED', reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const cipher = await openCipher(tx, actor.tenantId)
      return { row: updated, cipher }
    },
    tenantOptions(actor),
  )

  await invalidateSummary(actor.tenantId, result.row.petId)

  await publishEvent(RECORD_ROUTING_KEYS.atendimentoAnulado, {
    tenantId: actor.tenantId,
    attendanceId: id,
    appointmentId: result.row.appointmentId,
    petId: result.row.petId,
    tutorId: result.row.tutorId,
    reason: input.reason,
    voidedBy: actor.actorUserId ?? null,
  })

  recordMetric({
    metric: 'attendance_voided_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return toAttendance(result.row, result.cipher)
}

// ─── Registro lançado à mão (caminho de reparo) ───────────────────────────────

/**
 * AC-03 do §01 pelo lado do reparo: o atendimento aconteceu e o registro não veio.
 *
 * O encaixe do dia a dia **não** passa aqui — entra por `POST /v1/appointments/walk-in`
 * na agenda, que cria o agendamento retroativo e conclui, e o registro nasce do
 * evento como qualquer outro. Este caminho existe para o evento que se perdeu, e é
 * por isso que ele aceita `appointmentId`: o índice único parcial garante que o
 * reparo não conviva com um registro que apareça depois.
 */
export async function createAttendance(
  actor: ActorContext,
  input: CreateAttendanceInput,
): Promise<Attendance> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const pet = await tx.pet.findFirst({
        where: { id: input.petId, deletedAt: null },
        select: { id: true, petTutors: { where: { unlinkedAt: null, role: 'PRIMARY' }, take: 1 } },
      })
      if (!pet) throw notFound('Pet não encontrado')

      const tutorId = pet.petTutors[0]?.tutorId
      if (!tutorId) throw invalid('O pet não tem responsável ativo — vincule um tutor antes')

      let appointmentId: string | null = null
      if (input.appointmentId) {
        const appointment = await tx.appointment.findFirst({
          where: { id: input.appointmentId },
          select: { id: true, petId: true },
        })
        if (!appointment) throw notFound('Agendamento não encontrado')
        if (appointment.petId !== input.petId) {
          throw invalid('O agendamento informado é de outro pet')
        }
        const existing = await tx.attendance.findFirst({
          where: { appointmentId: input.appointmentId, status: { not: 'VOIDED' } },
          select: { id: true },
        })
        if (existing) throw alreadyRegistered()
        appointmentId = appointment.id
      }

      const cipher = await openCipher(tx, actor.tenantId)
      const finishedAt = new Date(input.finishedAt)
      const totalCents = input.items.reduce(
        (sum, item) => sum + item.unitPriceCents * item.quantity,
        0,
      )

      const created = await tx.attendance.create({
        data: {
          tenantId: actor.tenantId,
          petId: input.petId,
          tutorId,
          appointmentId,
          type: input.type,
          origin: 'RETROACTIVE',
          performedBy: input.performedBy,
          startedAt: new Date(input.startedAt),
          finishedAt,
          observationsEncrypted: encryptOptional(cipher, input.observations),
          ...(input.weightKg === undefined ? {} : { weightKg: input.weightKg }),
          status: 'COMPLETED',
          editableUntil: addHours(finishedAt, EDIT_WINDOW_HOURS),
          totalCents: BigInt(totalCents),
          createdBy: actor.actorUserId ?? null,
          items: {
            create: input.items.map((item) => ({
              tenantId: actor.tenantId,
              serviceId: item.serviceId,
              label: '',
              executedBy: item.executedBy,
              unitPriceCents: BigInt(item.unitPriceCents),
              quantity: item.quantity,
              totalPriceCents: BigInt(item.unitPriceCents * item.quantity),
              notes: item.notes ?? null,
              productsUsed: item.productsUsed,
            })),
          },
        },
        include: ATTENDANCE_INCLUDE,
      })

      // O rótulo é fotografia do nome (RN-07) e sai do catálogo no momento do
      // lançamento; buscá-lo depois do insert mantém uma única consulta por serviço.
      const services = await tx.service.findMany({
        where: { id: { in: input.items.map((item) => item.serviceId) } },
        select: { id: true, name: true },
      })
      const names = new Map(services.map((service) => [service.id, service.name]))
      for (const item of created.items) {
        await tx.attendanceItem.update({
          where: { id: item.id },
          data: { label: names.get(item.serviceId) ?? 'Serviço' },
        })
        item.label = names.get(item.serviceId) ?? 'Serviço'
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'attendance.created',
        entity: 'attendance',
        entityId: created.id,
        after: { origin: 'RETROACTIVE', appointmentId, totalCents, items: created.items.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { row: created, cipher }
    },
    tenantOptions(actor),
  )

  await invalidateSummary(actor.tenantId, result.row.petId)
  recordMetric({
    metric: 'attendance_created_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return toAttendance(result.row, result.cipher)
}

// ─── Apoio ───────────────────────────────────────────────────────────────────

/** RN-05: a janela de correção direta. Questão 1 do §11 pode encurtá-la. */
export const EDIT_WINDOW_HOURS = 24

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000)
}

async function loadForWrite(tx: TenantTransaction, id: string) {
  const row = await tx.attendance.findFirst({ where: { id }, include: ATTENDANCE_INCLUDE })
  if (!row) throw notFound('Atendimento não encontrado')
  return row
}

/**
 * §9: corrigir é do **autor** ou do administrador. A checagem mora no serviço, e não
 * num `preHandler`, porque depende do registro e não só do papel.
 *
 * "Autor" tem duas formas porque o registro nasce de duas maneiras. O lançado à mão
 * guarda `created_by`, que é um usuário. O que nasceu do check-out guarda só
 * `performed_by`, que é um **profissional** — e `professionals.user_id` é opcional,
 * porque a agenda tem gente que trabalha sem conta no sistema. Quando não há conta
 * ligada, ninguém é autor e só o administrador corrige: é o resultado certo, porque
 * não há como provar quem está do outro lado.
 */
export async function assertCanWrite(
  tx: TenantTransaction,
  actor: ActorContext,
  attendance: { performedBy: string; createdBy: string | null },
  isAdmin: boolean,
): Promise<void> {
  if (isAdmin) return
  if (!actor.actorUserId) throw forbidden('Correção exige usuário identificado')
  if (attendance.createdBy === actor.actorUserId) return

  const professional = await tx.professional.findFirst({
    where: { id: attendance.performedBy },
    select: { userId: true },
  })
  if (professional?.userId === actor.actorUserId) return

  throw forbidden('Só o autor do atendimento ou o administrador podem corrigi-lo')
}
