import { withTenant, type PetWeight, type TenantTransaction } from '@petshop/db'
import {
  PET_ROUTING_KEYS,
  weightVariation,
  type PetWeightRecord,
  type RecordWeightInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { invalid, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { recordMetric } from '../../lib/logger.js'
import { invalidatePet } from '../../lib/redis.js'
import { assertWritable } from './service.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * Histórico de peso (MOD-PET-07).
 *
 * RN-10 explica a duplicidade aparente entre `pets.weight_kg` e `pet_weights`: a
 * série é a verdade, a coluna é o atalho da listagem — e ela só acompanha a pesagem
 * **mais recente**. Lançar hoje uma pesagem de dois meses atrás corrige o histórico
 * clínico sem mexer no peso atual do animal, que é o que a balança de ontem disse.
 */

const SERIES_ORDER = [{ measuredAt: 'desc' as const }, { createdAt: 'desc' as const }]

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Série da mais recente para a mais antiga, cada ponto já comparado com o anterior:
 * é assim que a tela desenha a curva e o veterinário lê a queda sem fazer conta.
 */
export async function listWeights(tenantId: string, petId: string, limit = 50): Promise<PetWeightRecord[]> {
  return withTenant(tenantId, async (tx) => {
    await assertPetExists(tx, petId)
    const rows = await tx.petWeight.findMany({ where: { petId }, orderBy: SERIES_ORDER, take: limit })
    return toSeries(rows)
  })
}

// ─── Registro ────────────────────────────────────────────────────────────────

/**
 * Pesagem avulsa — a da balança do banho, sem abrir o cadastro do pet.
 *
 * RN-11 é resolvida aqui e não no consumidor do evento porque a comparação precisa
 * da linha anterior **dentro da mesma transação**: duas pesagens simultâneas do mesmo
 * pet, comparadas depois, sortearriam qual delas é a "anterior".
 */
export async function recordWeight(
  actor: ActorContext,
  petId: string,
  input: RecordWeightInput,
): Promise<PetWeightRecord> {
  const measuredAt = input.measuredAt ? new Date(input.measuredAt) : new Date()
  if (measuredAt.getTime() > Date.now() + 60_000) {
    throw invalid('A data da pesagem não pode estar no futuro', [
      { field: 'measuredAt', message: 'A data da pesagem não pode estar no futuro' },
    ])
  }

  const { record, tutorIds } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const pet = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!pet) throw notFound()
      assertWritable(pet)

      const previous = await tx.petWeight.findFirst({
        where: { petId, measuredAt: { lt: measuredAt } },
        orderBy: SERIES_ORDER,
      })

      const created = await tx.petWeight.create({
        data: {
          tenantId: actor.tenantId,
          petId,
          weightKg: input.weightKg,
          measuredAt,
          measuredBy: actor.actorUserId ?? null,
        },
      })

      // RN-10: a coluna denormalizada segue a pesagem mais recente da série, não a
      // última que chegou. Uma pesagem retroativa não pode "desatualizar" o pet.
      const newer = await tx.petWeight.findFirst({
        where: { petId, measuredAt: { gt: measuredAt } },
        select: { id: true },
      })
      if (!newer) {
        await tx.pet.update({
          where: { id: petId },
          data: { weightKg: input.weightKg, updatedBy: actor.actorUserId ?? null },
        })
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.weight_recorded',
        entity: 'pet',
        entityId: petId,
        after: { weightKg: input.weightKg, measuredAt: measuredAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const links = await tx.petTutor.findMany({
        where: { petId, unlinkedAt: null },
        select: { tutorId: true },
      })

      return { record: toRecord(created, previous), tutorIds: links.map((link) => link.tutorId) }
    },
    tenantOptions(actor),
  )

  await invalidatePet(actor.tenantId, petId, tutorIds)
  await publishWeightRecorded(actor.tenantId, petId, record)
  return record
}

/**
 * O evento de RN-11. Vive aqui, e não em cada chamador, porque `previousWeightKg` e
 * `variationPercent` são o que o prontuário usa para alertar o veterinário — e um
 * publicador que os mandasse nulos calaria o alerta sem ninguém notar.
 */
export async function publishWeightRecorded(
  tenantId: string,
  petId: string,
  record: PetWeightRecord,
): Promise<void> {
  await publishEvent(PET_ROUTING_KEYS.petPesoRegistrado, {
    tenantId,
    petId,
    weightKg: record.weightKg,
    previousWeightKg: record.previousWeightKg,
    variationPercent: record.variationPercent,
  })

  if (record.alert) {
    recordMetric({ metric: 'pet_weight_variation_alert_total', tenantId, value: 1, unit: 'count' })
  }
}

/** A última pesagem registrada, para quem grava peso por outro caminho (o PATCH do pet). */
export async function latestWeightBefore(
  tx: TenantTransaction,
  petId: string,
  measuredAt: Date,
): Promise<PetWeight | null> {
  return tx.petWeight.findFirst({ where: { petId, measuredAt: { lt: measuredAt } }, orderBy: SERIES_ORDER })
}

// ─── Conversão ───────────────────────────────────────────────────────────────

export function toRecord(row: PetWeight, previous: PetWeight | null): PetWeightRecord {
  const current = { weightKg: Number(row.weightKg), measuredAt: row.measuredAt }
  const variation = weightVariation(
    current,
    previous ? { weightKg: Number(previous.weightKg), measuredAt: previous.measuredAt } : null,
  )

  return {
    id: row.id,
    weightKg: current.weightKg,
    measuredAt: row.measuredAt.toISOString(),
    ...variation,
  }
}

/** A série vem em ordem decrescente; o "anterior" de cada ponto é o vizinho de baixo. */
function toSeries(rows: PetWeight[]): PetWeightRecord[] {
  return rows.map((row, index) => toRecord(row, rows[index + 1] ?? null))
}

async function assertPetExists(tx: TenantTransaction, petId: string): Promise<void> {
  const pet = await tx.pet.findFirst({ where: { id: petId, deletedAt: null }, select: { id: true } })
  if (!pet) throw notFound()
}
