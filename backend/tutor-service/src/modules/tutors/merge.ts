import { withTenant } from '@petshop/db'
import { TUTOR_ROUTING_KEYS, type MergeResult, type MergeTutorInput } from '@petshop/shared-types'
import { recordAudit, sanitize } from '../../lib/audit.js'
import { invalidMerge, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { invalidateTutor } from '../../lib/redis.js'
import type { ActorContext } from './service.js'

/**
 * Merge de duplicatas (MOD-TUTOR-09).
 *
 * Tudo em uma transação: revincular metade das entidades e falhar deixaria a base
 * pior do que a duplicata que o merge veio consertar.
 *
 * A origem não é apagada — vira `MERGED` apontando para o destino. Quem tiver o id
 * antigo guardado (um link, um relatório antigo, o histórico de conversa do agente)
 * continua chegando a algum lugar em vez de a um 404.
 *
 * AC-03: lançamentos financeiros são transferidos **um a um**, nunca o saldo
 * agregado. Somar saldos perderia a rastreabilidade de cada lançamento, e o saldo do
 * destino tem que continuar sendo derivável do ledger.
 */

/** Campos que o admin pode resolver escolhendo de que lado fica o valor. */
const RESOLVABLE_FIELDS = [
  'fullName',
  'socialName',
  'legalName',
  'cpf',
  'cnpj',
  'phone',
  'phoneAlt',
  'email',
  'birthDate',
  'notes',
] as const

type ResolvableField = (typeof RESOLVABLE_FIELDS)[number]

/** Coluna correspondente no banco, para cada campo resolvível. */
const FIELD_COLUMNS: Record<ResolvableField, string[]> = {
  fullName: ['fullName'],
  socialName: ['socialName'],
  legalName: ['legalName'],
  cpf: ['cpfEncrypted', 'cpfHash'],
  cnpj: ['cnpjEncrypted', 'cnpjHash'],
  phone: ['phoneEncrypted', 'phoneHash'],
  phoneAlt: ['phoneAltEncrypted', 'phoneAltHash'],
  email: ['emailEncrypted', 'emailHash'],
  birthDate: ['birthDate'],
  notes: ['notes'],
}

export async function mergeTutors(
  actor: ActorContext,
  targetId: string,
  input: MergeTutorInput,
): Promise<MergeResult> {
  if (input.sourceId === targetId) {
    throw invalidMerge('Cadastros inválidos para unificação: origem e destino são o mesmo')
  }

  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [source, target] = await Promise.all([
        tx.tutor.findFirst({ where: { id: input.sourceId } }),
        tx.tutor.findFirst({ where: { id: targetId } }),
      ])
      if (!source || !target) throw notFound('Um dos cadastros não foi encontrado')

      for (const tutor of [source, target]) {
        if (tutor.status === 'MERGED' || tutor.status === 'ANONYMIZED') {
          throw invalidMerge('Cadastros inválidos para unificação: um deles já é terminal')
        }
      }

      // Snapshot **antes** de qualquer escrita: é o que permite desfazer à mão.
      const snapshot = {
        source: sanitize(source),
        target: sanitize(target),
        fieldResolution: input.fieldResolution,
      }

      const resolved = resolveFields(source, input.fieldResolution)

      const addresses = await tx.tutorAddress.findMany({ where: { tutorId: input.sourceId } })
      await tx.tutorAddress.updateMany({
        where: { tutorId: input.sourceId },
        // O destino já tem o principal dele; os que vêm da origem entram como
        // secundários, para não colidir com o índice único parcial.
        data: { tutorId: targetId, isPrimary: false },
      })

      // O consentimento **não** se move. A tabela é append-only por trigger (RN-05),
      // e mover seria reescrever a prova: aquele opt-in foi dado naquele cadastro,
      // naquela data, daquele IP. O histórico fica na origem, alcançável pelo
      // `merged_into_id`, e o snapshot do merge registra o vínculo.
      //
      // Consequência operacional deliberada: se a origem tinha opt-in de WhatsApp e o
      // destino não, o destino continua sem — a recepção pede o aceite de novo. É o
      // lado seguro de errar quando o assunto é base legal de comunicação.
      const consents = await tx.tutorConsent.findMany({
        where: { tutorId: input.sourceId },
        select: { id: true },
      })

      // Tag já presente no destino não pode ser duplicada: a PK é (tutor, tag).
      const targetTagIds = new Set(
        (
          await tx.tutorTagAssignment.findMany({
            where: { tutorId: targetId },
            select: { tagId: true },
          })
        ).map((row) => row.tagId),
      )
      const sourceTags = await tx.tutorTagAssignment.findMany({
        where: { tutorId: input.sourceId },
      })
      const tagsToMove = sourceTags.filter((row) => !targetTagIds.has(row.tagId))
      if (tagsToMove.length > 0) {
        await tx.tutorTagAssignment.createMany({
          data: tagsToMove.map((row) => ({
            tenantId: actor.tenantId,
            tutorId: targetId,
            tagId: row.tagId,
            assignedBy: row.assignedBy,
          })),
        })
      }
      await tx.tutorTagAssignment.deleteMany({ where: { tutorId: input.sourceId } })

      // A origem perde os hashes: sem isso o índice único de CPF continuaria
      // ocupado e o destino não poderia ficar com o documento.
      await tx.tutor.update({
        where: { id: input.sourceId },
        data: {
          status: 'MERGED',
          mergedIntoId: targetId,
          cpfHash: null,
          cnpjHash: null,
          phoneHash: '',
          phoneAltHash: null,
          emailHash: null,
          updatedBy: actor.actorUserId ?? null,
        },
      })

      const updatedTarget = await tx.tutor.update({
        where: { id: targetId },
        data: {
          ...resolved,
          // AC-03: o saldo do destino é a soma dos lançamentos dos dois lados. Aqui
          // só o denormalizado; o ledger reconcilia ao consumir `tutor.mesclado`.
          balanceCents: target.balanceCents + source.balanceCents,
          petsCount: target.petsCount + source.petsCount,
          lastAttendanceAt: laterOf(target.lastAttendanceAt, source.lastAttendanceAt),
          updatedBy: actor.actorUserId ?? null,
        },
      })

      const movedEntities: Record<string, string[]> = {
        addresses: addresses.map((row) => row.id),
        /** Preservados na origem, não movidos — ver o comentário acima. */
        consentsKeptOnSource: consents.map((row) => row.id),
        tags: tagsToMove.map((row) => row.tagId),
        // TODO(MOD-PET, MOD-LEDGER, MOD-AGENDA): pets, lançamentos e agendamentos
        // são reapontados pelos respectivos serviços ao consumir `tutor.mesclado`.
        pets: [],
        ledgerEntries: [],
        appointments: [],
      }

      await tx.tutorMergeLog.create({
        data: {
          tenantId: actor.tenantId,
          sourceId: input.sourceId,
          targetId,
          snapshot: snapshot as object,
          movedEntities: movedEntities as object,
          performedBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.merged',
        entity: 'tutor',
        entityId: targetId,
        before: { sourceId: input.sourceId, sourceStatus: source.status },
        after: { targetId, movedEntities },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        movedEntities,
        phoneHashes: [source.phoneHash, target.phoneHash, updatedTarget.phoneHash].filter(Boolean),
      }
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await Promise.all([
    invalidateTutor(actor.tenantId, input.sourceId, result.phoneHashes),
    invalidateTutor(actor.tenantId, targetId, result.phoneHashes),
  ])

  await publishEvent(TUTOR_ROUTING_KEYS.tutorMesclado, {
    tenantId: actor.tenantId,
    sourceId: input.sourceId,
    targetId,
    movedEntities: result.movedEntities,
  })

  return { targetId, sourceId: input.sourceId, movedEntities: result.movedEntities }
}

/**
 * Aplica `fieldResolution`. O padrão é o destino: o admin escolheu qual cadastro
 * sobrevive, então o silêncio significa "fica como está".
 */
function resolveFields(
  source: Record<string, unknown>,
  resolution: Record<string, 'source' | 'target'>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}

  for (const field of RESOLVABLE_FIELDS) {
    if (resolution[field] !== 'source') continue
    for (const column of FIELD_COLUMNS[field]) {
      data[column] = source[column]
    }
  }

  return data
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}
