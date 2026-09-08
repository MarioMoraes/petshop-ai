import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  PET_ROUTING_KEYS,
  type PetResponse,
  type PetTransfer,
  type TransferPetInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { blockedByLink, conflict, invalid, notFound } from './errors.js'
import { publishEvent } from '../../shared/events.js'
import { invalidatePet } from '../../shared/redis.js'
import { getScheduling } from './scheduling-port.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { openCipher } from './crypto.js'
import { enrichPets, toDateString, toPetResponse, type PetRow } from './mapper.js'
import { assertWritable, WITH_DOMAIN } from './service.js'

/**
 * Transferência de titularidade (MOD-PET-05).
 *
 * RN-06 é a regra que dá forma ao módulo: o que muda de dono é o **cadastro**, nunca
 * o prontuário. Por isso a operação não copia nada — encerra os vínculos ativos,
 * abre um vínculo PRIMARY para o novo tutor e registra em `pet_transfer_log` quando
 * e por quê. O histórico clínico continua pendurado no mesmo `pet_id` que sempre
 * esteve.
 *
 * O tutor anterior perde o pet, não o passado dele (RN-07): as linhas de
 * `pet_tutors` ficam com `unlinked_at` preenchido, e é por elas que o Portal
 * continua mostrando os recibos dos serviços que ele pagou.
 *
 * O AC-02 — agendamento futuro bloqueia — entra pela porta de `lib/scheduling.ts`,
 * que hoje responde vazio porque MOD-AGENDA ainda não existe.
 */

export async function transferPet(
  actor: ActorContext,
  petId: string,
  input: TransferPetInput,
): Promise<PetResponse> {
  const { pet, fromTutorId, previousTutorIds } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!row) throw notFound()
      assertWritable(row)

      const toTutor = await tx.tutor.findFirst({
        where: { id: input.toTutorId, deletedAt: null },
        select: { id: true, status: true },
      })
      if (!toTutor) {
        throw invalid('Tutor não encontrado', [{ field: 'toTutorId', message: 'Tutor não encontrado' }])
      }
      if (toTutor.status === 'ANONYMIZED' || toTutor.status === 'MERGED') {
        throw invalid('Este cadastro de tutor não aceita novos vínculos', [
          { field: 'toTutorId', message: 'Cadastro de tutor indisponível' },
        ])
      }

      const activeLinks = await tx.petTutor.findMany({
        where: { petId, unlinkedAt: null },
        orderBy: [{ role: 'asc' }, { linkedAt: 'asc' }],
      })

      // Transferir para quem já é o principal não é transferência — é ruído no
      // histórico, e o log é append-only: entraria e não sairia mais.
      const currentPrimary = activeLinks.find((link) => link.role === 'PRIMARY')
      if (currentPrimary?.tutorId === input.toTutorId) {
        throw conflict('Este tutor já é o responsável principal do pet', {
          currentPrimary: { linkId: currentPrimary.id, tutorId: currentPrimary.tutorId },
        })
      }

      // AC-02: agendamento futuro bloqueia a transferência. A pergunta vai à porta da
      // agenda — hoje respondida com uma lista vazia, porque MOD-AGENDA não existe.
      // A regra fica escrita e no caminho desde já; o que falta é quem responda.
      const upcoming = await getScheduling().listFuturePetAppointments(tx, actor.tenantId, petId)
      if (upcoming.length > 0) {
        throw blockedByLink(
          upcoming.length === 1
            ? 'Este pet tem um agendamento futuro. Cancele ou reatribua antes de transferir.'
            : `Este pet tem ${upcoming.length} agendamentos futuros. Cancele ou reatribua antes de transferir.`,
          { appointments: upcoming },
        )
      }

      const now = new Date()
      await tx.petTutor.updateMany({
        where: { petId, unlinkedAt: null },
        data: { unlinkedAt: now },
      })

      await tx.petTutor.create({
        data: {
          tenantId: actor.tenantId,
          petId,
          tutorId: input.toTutorId,
          role: 'PRIMARY',
          canAuthorizeProcedures: true,
          linkedAt: now,
          createdBy: actor.actorUserId ?? null,
        },
      })

      const fromTutorId = currentPrimary?.tutorId ?? activeLinks[0]?.tutorId ?? null

      await tx.petTransferLog.create({
        data: {
          tenantId: actor.tenantId,
          petId,
          fromTutorId,
          toTutorId: input.toTutorId,
          reason: input.reason,
          notes: input.notes ?? null,
          // A data declarada fica no log; os vínculos mudam no commit. Fingir que o
          // vínculo começou no passado bagunçaria a rastreabilidade de quem autorizou
          // procedimento entre a data informada e hoje.
          effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
          performedBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.transferred',
        entity: 'pet',
        entityId: petId,
        before: { tutorIds: activeLinks.map((link) => link.tutorId) },
        after: { toTutorId: input.toTutorId, reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const reloaded = await tx.pet.findFirst({ where: { id: petId }, include: WITH_DOMAIN })
      if (!reloaded) throw notFound()
      const cipher = await openCipher(tx, actor.tenantId)
      const [mapped] = await enrichPets(
        tx,
        [reloaded],
        [toPetResponse(reloaded as PetRow, cipher)],
      )

      return {
        pet: mapped as PetResponse,
        fromTutorId,
        previousTutorIds: activeLinks.map((link) => link.tutorId),
      }
    },
    tenantOptions(actor),
  )

  const touchedTutorIds = [...new Set([...previousTutorIds, input.toTutorId])]
  await invalidatePet(actor.tenantId, petId, touchedTutorIds)

  await publishEvent(PET_ROUTING_KEYS.petTransferido, {
    tenantId: actor.tenantId,
    petId,
    fromTutorId: fromTutorId ?? '',
    toTutorId: input.toTutorId,
    reason: input.reason,
  })

  // `pets_count` do tutor-service é recontado a partir destes eventos: sem eles, o
  // tutor anterior continuaria contando um pet que não é mais dele.
  for (const tutorId of previousTutorIds) {
    await publishEvent(PET_ROUTING_KEYS.petVinculoAlterado, {
      tenantId: actor.tenantId,
      petId,
      tutorId,
      action: 'UNLINKED',
      role: 'SECONDARY',
    })
  }
  await publishEvent(PET_ROUTING_KEYS.petVinculoAlterado, {
    tenantId: actor.tenantId,
    petId,
    tutorId: input.toTutorId,
    action: 'LINKED',
    role: 'PRIMARY',
  })

  return pet
}

/** O histórico de titularidade do pet, o que a aba "Responsáveis" mostra abaixo dos vínculos. */
export async function listTransfers(tenantId: string, petId: string): Promise<PetTransfer[]> {
  return withTenant(tenantId, async (tx) => {
    const pet = await tx.pet.findFirst({ where: { id: petId, deletedAt: null }, select: { id: true } })
    if (!pet) throw notFound()

    const rows = await tx.petTransferLog.findMany({ where: { petId }, orderBy: { createdAt: 'desc' } })
    const names = await tutorNames(
      tx,
      rows.flatMap((row) => [row.fromTutorId, row.toTutorId]),
    )

    return rows.map((row) => ({
      id: row.id,
      fromTutorId: row.fromTutorId,
      fromTutorName: row.fromTutorId ? (names.get(row.fromTutorId) ?? null) : null,
      toTutorId: row.toTutorId,
      toTutorName: names.get(row.toTutorId) ?? 'Tutor removido',
      reason: row.reason,
      notes: row.notes,
      effectiveDate: row.effectiveDate ? toDateString(row.effectiveDate) : null,
      createdAt: row.createdAt.toISOString(),
    }))
  })
}

/**
 * Nomes para o histórico. Um tutor anonimizado (MOD-TUTOR-08) continua no log com o
 * id — é o rótulo que some, não o registro da transferência.
 */
async function tutorNames(
  tx: TenantTransaction,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))]
  if (unique.length === 0) return new Map()

  const rows = await tx.tutor.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true, socialName: true },
  })
  return new Map(rows.map((row) => [row.id, row.socialName ?? row.fullName]))
}
