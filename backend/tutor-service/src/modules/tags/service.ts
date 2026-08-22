import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  TUTOR_ROUTING_KEYS,
  isSystemTagKey,
  type SYSTEM_TAG_KEYS,
  type AssignTagResult,
  type CreateTagInput,
  type Tag,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { forbidden, invalid, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { CACHE_KEYS, cacheDelete, invalidateTutor } from '../../lib/redis.js'
import type { ActorContext } from '../tutors/service.js'

/**
 * Tags de segmentação (MOD-TUTOR-05).
 *
 * Duas naturezas na mesma tabela: manuais ("VIP"), que a recepção aplica, e de
 * sistema (INATIVO, INADIMPLENTE, ANIVERSARIANTE), mantidas por evento. A separação
 * é `is_system`, e ela é dura: deixar alguém aplicar INADIMPLENTE à mão faria a tag
 * mentir sobre o ledger na primeira vez que fosse usada.
 */

/** Rótulos das tags de sistema, criadas sob demanda no primeiro uso. */
const SYSTEM_TAG_SEED: Record<(typeof SYSTEM_TAG_KEYS)[number], { label: string; color: string }> = {
  INATIVO: { label: 'Inativo', color: '#8A8A8A' },
  INADIMPLENTE: { label: 'Inadimplente', color: '#C0392B' },
  ANIVERSARIANTE: { label: 'Aniversariante', color: '#E8A33D' },
}

export async function listTags(tenantId: string): Promise<Tag[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.tutorTag.findMany({ orderBy: [{ isSystem: 'asc' }, { label: 'asc' }] })
    return rows.map(toTag)
  })
}

export async function createTag(actor: ActorContext, input: CreateTagInput): Promise<Tag> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const existing = await tx.tutorTag.findFirst({ where: { key: input.key } })
      if (existing) throw invalid('Já existe uma tag com esta chave')

      const created = await tx.tutorTag.create({
        data: {
          tenantId: actor.tenantId,
          key: input.key,
          label: input.label,
          color: input.color,
          isSystem: false,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.tag_created',
        entity: 'tutor_tag',
        entityId: created.id,
        after: { key: created.key, label: created.label },
        ipAddress: actor.ipAddress ?? null,
      })

      return toTag(created)
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )
}

/**
 * AC-01: atribuição em lote e **idempotente** — reaplicar a tag a quem já a tem não
 * é erro, é no-op. O retorno separa os dois números para a UI dizer o que aconteceu.
 */
export async function assignTag(
  actor: ActorContext,
  tagId: string,
  tutorIds: string[],
): Promise<AssignTagResult> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const tag = await tx.tutorTag.findFirst({ where: { id: tagId } })
      if (!tag) throw notFound('Tag não encontrada')
      // AC-02: tag automática é mantida pelo sistema, nunca pela mão de alguém.
      if (tag.isSystem) throw forbidden('Tags automáticas são mantidas pelo sistema')

      const existingTutors = await tx.tutor.findMany({
        where: { id: { in: tutorIds }, deletedAt: null, status: { notIn: ['MERGED', 'ANONYMIZED'] } },
        select: { id: true },
      })
      const validIds = existingTutors.map((row) => row.id)

      const already = await tx.tutorTagAssignment.findMany({
        where: { tagId, tutorId: { in: validIds } },
        select: { tutorId: true },
      })
      const alreadySet = new Set(already.map((row) => row.tutorId))
      const toAssign = validIds.filter((id) => !alreadySet.has(id))

      if (toAssign.length > 0) {
        await tx.tutorTagAssignment.createMany({
          data: toAssign.map((tutorId) => ({
            tenantId: actor.tenantId,
            tutorId,
            tagId,
            assignedBy: actor.actorUserId ?? null,
          })),
        })
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.tag_assigned',
        entity: 'tutor_tag',
        entityId: tagId,
        after: { key: tag.key, assigned: toAssign.length, alreadyAssigned: alreadySet.size },
        ipAddress: actor.ipAddress ?? null,
      })

      return { assigned: toAssign.length, alreadyAssigned: alreadySet.size, tagKey: tag.key, toAssign }
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await cacheDelete(CACHE_KEYS.tagCounts(actor.tenantId))
  for (const tutorId of result.toAssign) {
    await invalidateTutor(actor.tenantId, tutorId)
    await publishEvent(TUTOR_ROUTING_KEYS.tutorTagAplicada, {
      tenantId: actor.tenantId,
      tutorId,
      tagKey: result.tagKey,
      automatic: false,
    })
  }

  return { assigned: result.assigned, alreadyAssigned: result.alreadyAssigned }
}

export async function removeTag(
  actor: ActorContext,
  tutorId: string,
  tagId: string,
): Promise<void> {
  const tagKey = await withTenant(
    actor.tenantId,
    async (tx) => {
      const tag = await tx.tutorTag.findFirst({ where: { id: tagId } })
      if (!tag) throw notFound('Tag não encontrada')
      if (tag.isSystem) throw forbidden('Tags automáticas são mantidas pelo sistema')

      const deleted = await tx.tutorTagAssignment.deleteMany({ where: { tutorId, tagId } })
      if (deleted.count === 0) throw notFound('Este tutor não tem esta tag')

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.tag_removed',
        entity: 'tutor_tag',
        entityId: tagId,
        before: { key: tag.key, tutorId },
        ipAddress: actor.ipAddress ?? null,
      })

      return tag.key
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId)
  await cacheDelete(CACHE_KEYS.tagCounts(actor.tenantId))
  await publishEvent(TUTOR_ROUTING_KEYS.tutorTagRemovida, {
    tenantId: actor.tenantId,
    tutorId,
    tagKey,
    automatic: false,
  })
}

// ─── Tags de sistema ─────────────────────────────────────────────────────────

/**
 * Aplica ou remove tag de sistema. Não é exposta em rota: só os consumidores de
 * evento chamam (AC-03 de MOD-TUTOR-05, RN-12).
 */
export async function setSystemTag(
  tx: TenantTransaction,
  params: { tenantId: string; tutorId: string; key: string; applied: boolean },
): Promise<boolean> {
  if (!isSystemTagKey(params.key)) {
    throw invalid(`${params.key} não é uma tag de sistema`)
  }

  const tag = await ensureSystemTag(tx, params.tenantId, params.key)

  if (params.applied) {
    const existing = await tx.tutorTagAssignment.findUnique({
      where: { tutorId_tagId: { tutorId: params.tutorId, tagId: tag.id } },
    })
    if (existing) return false
    await tx.tutorTagAssignment.create({
      data: { tenantId: params.tenantId, tutorId: params.tutorId, tagId: tag.id, assignedBy: null },
    })
    return true
  }

  const removed = await tx.tutorTagAssignment.deleteMany({
    where: { tutorId: params.tutorId, tagId: tag.id },
  })
  return removed.count > 0
}

/**
 * Cria a tag de sistema no primeiro uso, em vez de semear todas no provisionamento:
 * um tenant que nunca teve inadimplente não precisa da tag INADIMPLENTE na lista.
 */
async function ensureSystemTag(
  tx: TenantTransaction,
  tenantId: string,
  key: (typeof SYSTEM_TAG_KEYS)[number] | string,
) {
  const existing = await tx.tutorTag.findFirst({ where: { key } })
  if (existing) return existing

  const seed = SYSTEM_TAG_SEED[key as (typeof SYSTEM_TAG_KEYS)[number]]
  return tx.tutorTag.create({
    data: { tenantId, key, label: seed.label, color: seed.color, isSystem: true },
  })
}

function toTag(row: { id: string; key: string; label: string; color: string; isSystem: boolean }): Tag {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    color: row.color,
    isSystem: row.isSystem,
  }
}
