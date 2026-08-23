import { withTenant } from '@petshop/db'
import {
  DEATH_REVERSAL_WINDOW_DAYS,
  PET_ROUTING_KEYS,
  type PetResponse,
  type RegisterDeathInput,
  type RevertDeathInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { blockedByLink, conflict, invalid, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { invalidatePet } from '../../lib/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { openCipher } from './crypto.js'
import { attachCoverUrls, toPetResponse, type PetRow } from './mapper.js'
import { WITH_DOMAIN } from './service.js'

/**
 * Óbito e sua reversão (MOD-PET-08).
 *
 * O óbito não é um `status` como os outros e por isso não entra pelo PATCH genérico:
 * ele dispara supressão de campanha e cancelamento de agendamento, e um efeito
 * desses não pode sair de um formulário de edição por acidente. RN-08 é a razão
 * inteira do módulo — mandar "parabéns pelo aniversário do Thor" para um tutor
 * enlutado é o pior defeito que este produto pode ter.
 */

export async function registerDeath(
  actor: ActorContext,
  petId: string,
  input: RegisterDeathInput,
): Promise<PetResponse> {
  const deceasedAt = new Date(`${input.deceasedAt}T00:00:00.000Z`)
  const today = new Date()
  if (deceasedAt.getTime() > today.getTime()) {
    throw invalid('A data do óbito não pode estar no futuro', [
      { field: 'deceasedAt', message: 'A data do óbito não pode estar no futuro' },
    ])
  }

  const { pet, tutorIds } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!row) throw notFound()

      if (row.status === 'DECEASED') {
        throw conflict('Este pet já está registrado como falecido')
      }
      if (row.status === 'TRANSFERRED_OUT') {
        throw conflict('Este pet foi transferido para outro estabelecimento')
      }
      if (row.birthDate && deceasedAt.getTime() < row.birthDate.getTime()) {
        throw invalid('A data do óbito é anterior ao nascimento do pet', [
          { field: 'deceasedAt', message: 'A data do óbito é anterior ao nascimento do pet' },
        ])
      }

      const links = await tx.petTutor.findMany({
        where: { petId, unlinkedAt: null },
        select: { tutorId: true },
      })

      await tx.pet.update({
        where: { id: petId },
        data: {
          status: 'DECEASED',
          deceasedAt,
          // A janela de reversão do AC-03 conta daqui, não de `deceasedAt`.
          deceasedRecordedAt: new Date(),
          updatedBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.deceased',
        entity: 'pet',
        entityId: petId,
        before: { status: row.status },
        after: { status: 'DECEASED', deceasedAt: input.deceasedAt, notes: input.notes ?? null },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { pet: await reload(tx, petId, actor.tenantId), tutorIds: links.map((l) => l.tutorId) }
    },
    tenantOptions(actor),
  )

  await invalidatePet(actor.tenantId, petId, tutorIds)

  // Os tutores vão no payload porque quem suprime campanha (MOD-CRM) segmenta por
  // pessoa, não por pet: sem a lista, o consumidor teria de consultar o pet-service
  // no exato momento em que precisa ser rápido e calado.
  await publishEvent(PET_ROUTING_KEYS.petObito, {
    tenantId: actor.tenantId,
    petId,
    tutorIds,
    deceasedAt: input.deceasedAt,
  })

  return pet
}

/**
 * AC-03: reversão em até 30 dias, com justificativa e auditoria.
 *
 * Depois da janela o caminho é o suporte — não por burocracia, mas porque um mês
 * depois já houve campanha suprimida, agendamento cancelado e possivelmente um
 * segundo cadastro do mesmo animal. Desfazer isso não é um UPDATE.
 */
export async function revertDeath(
  actor: ActorContext,
  petId: string,
  input: RevertDeathInput,
): Promise<PetResponse> {
  const { pet, tutorIds } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!row) throw notFound()
      if (row.status !== 'DECEASED') {
        throw conflict('Este pet não está registrado como falecido')
      }

      const recordedAt = row.deceasedRecordedAt ?? row.updatedAt
      const elapsedDays = (Date.now() - recordedAt.getTime()) / 86_400_000
      if (elapsedDays > DEATH_REVERSAL_WINDOW_DAYS) {
        throw blockedByLink(
          `A reversão é permitida em até ${DEATH_REVERSAL_WINDOW_DAYS} dias do registro. Acione o suporte.`,
          { recordedAt: recordedAt.toISOString(), elapsedDays: Math.floor(elapsedDays) },
        )
      }

      const links = await tx.petTutor.findMany({
        where: { petId, unlinkedAt: null },
        select: { tutorId: true },
      })

      await tx.pet.update({
        where: { id: petId },
        data: {
          status: 'ACTIVE',
          deceasedAt: null,
          deceasedRecordedAt: null,
          updatedBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.deceased_reverted',
        entity: 'pet',
        entityId: petId,
        before: { status: 'DECEASED', deceasedAt: row.deceasedAt?.toISOString() ?? null },
        // A justificativa é o motivo de a reversão existir como operação própria:
        // ela vive na trilha, e não no cadastro, porque é sobre o registro anterior.
        after: { status: 'ACTIVE', justification: input.justification },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { pet: await reload(tx, petId, actor.tenantId), tutorIds: links.map((l) => l.tutorId) }
    },
    tenantOptions(actor),
  )

  await invalidatePet(actor.tenantId, petId, tutorIds)

  // Reversão sai como atualização comum: quem suprimiu campanha por `pet.obito`
  // precisa reavaliar, e não existe evento de "desóbito" no §8.
  await publishEvent(PET_ROUTING_KEYS.petAtualizado, {
    tenantId: actor.tenantId,
    petId,
    changedFields: ['status', 'deceasedAt'],
  })

  return pet
}

async function reload(
  tx: Parameters<typeof openCipher>[0],
  petId: string,
  tenantId: string,
): Promise<PetResponse> {
  const row = await tx.pet.findFirst({ where: { id: petId }, include: WITH_DOMAIN })
  if (!row) throw notFound()
  const cipher = await openCipher(tx, tenantId)
  const [mapped] = await attachCoverUrls(tx, [row], [toPetResponse(row as PetRow, cipher)])
  return mapped as PetResponse
}
