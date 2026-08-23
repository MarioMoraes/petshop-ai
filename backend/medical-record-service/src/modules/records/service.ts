import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  RECORD_ROUTING_KEYS,
  type AllergyCheckResult,
  type Allergy as AllergyDto,
  type CreateAllergyInput,
  type CreateMedicalAlertInput,
  type MedicalAlert as MedicalAlertDto,
  type RecordTemperamentInput,
  type SafetyRecord,
  type Temperament as TemperamentDto,
  type TemperamentHistory,
  type UpdateAllergyInput,
  type UpdateMedicalAlertInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { allergyConflict, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { recordMetric } from '../../lib/logger.js'
import { invalidateAlerts } from '../../lib/redis.js'
import { hadRiskHistory, highestSeverity, loadAlertSources, toPetAlerts } from './alerts.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { encryptOptional, openCipher } from './crypto.js'
import { toAllergy, toMedicalAlert, toTemperament } from './mapper.js'

/**
 * Prontuário de segurança (MOD-PRONT-03/04/05).
 *
 * A regra que atravessa o módulo inteiro é a do §3: **nada aqui é apagado**. Alergia
 * reavaliada é desativada com justificativa, temperamento novo rebaixa o anterior
 * sem sumir com ele. Informação de segurança que desaparece do histórico é
 * exatamente a que faz falta seis meses depois, quando ninguém lembra por que o
 * registro sumiu.
 */

// ─── Leitura ─────────────────────────────────────────────────────────────────

/** O que a aba "Prontuário" do pet carrega de uma vez. */
export async function getSafetyRecord(tenantId: string, petId: string): Promise<SafetyRecord> {
  return withTenant(tenantId, async (tx) => {
    await assertPetExists(tx, petId)
    const cipher = await openCipher(tx, tenantId)

    const [allergies, temperaments, medicalAlerts, sources] = await Promise.all([
      tx.allergy.findMany({ where: { petId }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] }),
      tx.temperament.findMany({ where: { petId }, orderBy: { observedAt: 'desc' } }),
      tx.medicalAlert.findMany({
        where: { petId },
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      }),
      loadAlertSources(tx, petId),
    ])

    const history = temperaments.map((row) => toTemperament(row, cipher))
    return {
      allergies: allergies.map((row) => toAllergy(row, cipher)),
      temperament: {
        current: history.find((entry) => entry.isCurrent) ?? null,
        history,
        // RN-16: o passado não some porque o presente melhorou.
        hadRiskHistory: hadRiskHistory(temperaments),
      },
      medicalAlerts: medicalAlerts.map((row) => toMedicalAlert(row, cipher)),
      alerts: toPetAlerts(sources),
    }
  })
}

export async function getTemperamentHistory(
  tenantId: string,
  petId: string,
): Promise<TemperamentHistory> {
  const record = await getSafetyRecord(tenantId, petId)
  return record.temperament
}

// ─── Alergias (MOD-PRONT-03) ─────────────────────────────────────────────────

export async function createAllergy(
  actor: ActorContext,
  petId: string,
  input: CreateAllergyInput,
): Promise<AllergyDto> {
  const allergy = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertPetExists(tx, petId)
      const cipher = await openCipher(tx, actor.tenantId)

      const created = await tx.allergy.create({
        data: {
          tenantId: actor.tenantId,
          petId,
          type: input.type,
          label: input.label.trim(),
          severity: input.severity,
          reactionEncrypted: encryptOptional(cipher, input.reaction),
          blocksServices: input.blocksServices,
          blocksProducts: input.blocksProducts,
          diagnosedAt: input.diagnosedAt ? new Date(input.diagnosedAt) : null,
          diagnosedBy: actor.actorUserId ?? null,
          createdBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'allergy.created',
        entity: 'pet',
        entityId: petId,
        after: { allergyId: created.id, label: created.label, severity: created.severity },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toAllergy(created, cipher)
    },
    tenantOptions(actor),
  )

  await announceAlertChange(actor.tenantId, petId, 'ALLERGY', 'CREATED')
  return allergy
}

export async function updateAllergy(
  actor: ActorContext,
  petId: string,
  allergyId: string,
  patch: UpdateAllergyInput,
): Promise<AllergyDto> {
  const allergy = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.allergy.findFirst({ where: { id: allergyId, petId } })
      if (!before) throw notFound('Alergia não encontrada')

      const cipher = await openCipher(tx, actor.tenantId)
      // AC-04: desativar preserva a linha, com quem desativou e por quê. O `active`
      // é o único campo cuja mudança carrega essa contabilidade junto.
      const deactivating = patch.active === false && before.active

      const updated = await tx.allergy.update({
        where: { id: allergyId },
        data: {
          ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
          ...(patch.reaction !== undefined
            ? { reactionEncrypted: encryptOptional(cipher, patch.reaction) }
            : {}),
          ...(patch.blocksServices !== undefined ? { blocksServices: patch.blocksServices } : {}),
          ...(patch.blocksProducts !== undefined ? { blocksProducts: patch.blocksProducts } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(patch.resolutionNotes !== undefined
            ? { resolutionNotes: patch.resolutionNotes }
            : {}),
          ...(deactivating
            ? { deactivatedAt: new Date(), deactivatedBy: actor.actorUserId ?? null }
            : {}),
          ...(patch.active === true ? { deactivatedAt: null, deactivatedBy: null } : {}),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: deactivating ? 'allergy.deactivated' : 'allergy.updated',
        entity: 'pet',
        entityId: petId,
        before: { severity: before.severity, active: before.active },
        after: {
          allergyId,
          severity: updated.severity,
          active: updated.active,
          resolutionNotes: updated.resolutionNotes,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toAllergy(updated, cipher)
    },
    tenantOptions(actor),
  )

  await announceAlertChange(
    actor.tenantId,
    petId,
    'ALLERGY',
    patch.active === false ? 'DEACTIVATED' : 'UPDATED',
  )
  return allergy
}

/**
 * RN-03/RN-04 — o serviço esbarra em alguma alergia deste pet?
 *
 * Três respostas possíveis, e a diferença entre elas é o que o MOD-AGENDA faz:
 * `blocked` exige override com justificativa, `warnings` exige reconhecimento, e
 * nenhum dos dois impede o atendimento. Bloqueio duro aqui faria a recepção
 * cadastrar o serviço errado só para conseguir salvar.
 */
export async function checkAllergies(
  tenantId: string,
  petId: string,
  serviceIds: string[],
): Promise<AllergyCheckResult> {
  return withTenant(tenantId, async (tx) => {
    await assertPetExists(tx, petId)
    const cipher = await openCipher(tx, tenantId)

    const conflicting = await tx.allergy.findMany({
      where: { petId, active: true, blocksServices: { hasSome: serviceIds } },
      orderBy: { createdAt: 'desc' },
    })

    const mapped = conflicting.map((row) => toAllergy(row, cipher))
    return {
      blocked: mapped.some((allergy) => allergy.severity === 'CRITICAL'),
      blocking: mapped.filter((allergy) => allergy.severity === 'CRITICAL'),
      warnings: mapped.filter((allergy) => allergy.severity !== 'CRITICAL'),
    }
  })
}

/**
 * A mesma checagem, mas em forma de guarda: estoura 409 `ERR_PRONT_005` com as
 * alergias no corpo. É o que o MOD-AGENDA chama antes de gravar o agendamento.
 */
export async function assertServicesAllowed(
  tenantId: string,
  petId: string,
  serviceIds: string[],
  acknowledged = false,
): Promise<AllergyCheckResult> {
  const result = await checkAllergies(tenantId, petId, serviceIds)

  if (result.blocked && !acknowledged) {
    const labels = result.blocking.map((allergy) => allergy.label).join(', ')
    throw allergyConflict(`Serviço incompatível com alergia registrada (${labels} — CRÍTICA)`, {
      blocking: result.blocking,
      warnings: result.warnings,
    })
  }

  return result
}

// ─── Temperamento (MOD-PRONT-04) ─────────────────────────────────────────────

/**
 * Cada observação é uma linha nova, nunca um UPDATE.
 *
 * RN-15 quer exatamente um vigente, e o índice único parcial garante isso. Rebaixar
 * o anterior e inserir o novo na mesma transação é o que impede a janela em que o
 * pet fica com dois temperamentos vigentes — ou com nenhum.
 */
export async function recordTemperament(
  actor: ActorContext,
  petId: string,
  input: RecordTemperamentInput,
): Promise<TemperamentDto> {
  const temperament = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertPetExists(tx, petId)
      const cipher = await openCipher(tx, actor.tenantId)

      await tx.temperament.updateMany({
        where: { petId, isCurrent: true },
        data: { isCurrent: false },
      })

      const created = await tx.temperament.create({
        data: {
          tenantId: actor.tenantId,
          petId,
          classification: input.classification,
          contexts: input.contexts,
          requiresMuzzle: input.requiresMuzzle,
          requiresTwoHandlers: input.requiresTwoHandlers,
          notesEncrypted: encryptOptional(cipher, input.notes),
          observedBy: actor.actorUserId ?? null,
          isCurrent: true,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'temperament.recorded',
        entity: 'pet',
        entityId: petId,
        after: {
          temperamentId: created.id,
          classification: created.classification,
          requiresMuzzle: created.requiresMuzzle,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toTemperament(created, cipher)
    },
    tenantOptions(actor),
  )

  await announceAlertChange(actor.tenantId, petId, 'TEMPERAMENT', 'CREATED')
  return temperament
}

// ─── Alertas médicos (MOD-PRONT-05) ──────────────────────────────────────────

export async function createMedicalAlert(
  actor: ActorContext,
  petId: string,
  input: CreateMedicalAlertInput,
): Promise<MedicalAlertDto> {
  const alert = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertPetExists(tx, petId)
      const cipher = await openCipher(tx, actor.tenantId)

      const created = await tx.medicalAlert.create({
        data: {
          tenantId: actor.tenantId,
          petId,
          condition: input.condition.trim(),
          severity: input.severity,
          instructionsEncrypted: encryptOptional(cipher, input.instructions),
          createdBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'medical_alert.created',
        entity: 'pet',
        entityId: petId,
        after: { alertId: created.id, condition: created.condition, severity: created.severity },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toMedicalAlert(created, cipher)
    },
    tenantOptions(actor),
  )

  await announceAlertChange(actor.tenantId, petId, 'MEDICAL', 'CREATED')
  return alert
}

export async function updateMedicalAlert(
  actor: ActorContext,
  petId: string,
  alertId: string,
  patch: UpdateMedicalAlertInput,
): Promise<MedicalAlertDto> {
  const alert = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.medicalAlert.findFirst({ where: { id: alertId, petId } })
      if (!before) throw notFound('Alerta médico não encontrado')

      const cipher = await openCipher(tx, actor.tenantId)
      const deactivating = patch.active === false && before.active

      const updated = await tx.medicalAlert.update({
        where: { id: alertId },
        data: {
          ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
          ...(patch.instructions !== undefined
            ? { instructionsEncrypted: encryptOptional(cipher, patch.instructions) }
            : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(patch.resolutionNotes !== undefined
            ? { resolutionNotes: patch.resolutionNotes }
            : {}),
          ...(deactivating
            ? { deactivatedAt: new Date(), deactivatedBy: actor.actorUserId ?? null }
            : {}),
          ...(patch.active === true ? { deactivatedAt: null, deactivatedBy: null } : {}),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: deactivating ? 'medical_alert.deactivated' : 'medical_alert.updated',
        entity: 'pet',
        entityId: petId,
        before: { severity: before.severity, active: before.active },
        after: { alertId, severity: updated.severity, active: updated.active },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toMedicalAlert(updated, cipher)
    },
    tenantOptions(actor),
  )

  await announceAlertChange(
    actor.tenantId,
    petId,
    'MEDICAL',
    patch.active === false ? 'DEACTIVATED' : 'UPDATED',
  )
  return alert
}

// ─── Regras compartilhadas ───────────────────────────────────────────────────

/**
 * O pet existe neste tenant? O RLS já esconderia o de outro estabelecimento, então
 * o 404 aqui é sobre o pet, não sobre o registro clínico — e é o mesmo 404 que o
 * atacante recebe ao sondar um id de outro tenant.
 */
async function assertPetExists(tx: TenantTransaction, petId: string): Promise<void> {
  const pet = await tx.pet.findFirst({
    where: { id: petId, deletedAt: null },
    select: { id: true },
  })
  if (!pet) throw notFound('Pet não encontrado')
}

/**
 * Invalida os caches e avisa o resto do sistema.
 *
 * A ordem importa: invalidar **antes** de publicar. O consumidor do evento vai
 * invalidar de novo, e a redundância é barata; a janela em que a ficha do pet ainda
 * mostra a alergia recém-desativada, não.
 */
async function announceAlertChange(
  tenantId: string,
  petId: string,
  kind: 'ALLERGY' | 'TEMPERAMENT' | 'MEDICAL',
  action: 'CREATED' | 'UPDATED' | 'DEACTIVATED',
): Promise<void> {
  await invalidateAlerts(tenantId, petId)

  const alerts = await withTenant(tenantId, async (tx) => toPetAlerts(await loadAlertSources(tx, petId)))
  const severity = highestSeverity(alerts)

  await publishEvent(RECORD_ROUTING_KEYS.alertaAlterado, {
    tenantId,
    petId,
    kind,
    action,
    highestSeverity: severity,
  })

  // §10: pets com alerta CRITICAL ativo é indicador de segurança da equipe.
  if (severity === 'CRITICAL') {
    recordMetric({ metric: 'pet_alerts_active_total', tenantId, value: 1, unit: 'count' })
  }
}
