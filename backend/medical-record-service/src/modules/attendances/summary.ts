import { withTenant } from '@petshop/db'
import type { PetClinicalSummary } from '@petshop/shared-types'
import { cacheGet, cacheSet } from '../../lib/redis.js'
import { notFound } from '../../lib/errors.js'
import { loadAlertSources } from '../records/alerts.js'
import { decryptOptional, openCipher } from '../records/crypto.js'
import { SUMMARY_KEY, SUMMARY_TTL_SECONDS } from './cache.js'

/**
 * MOD-PRONT-11 — o resumo clínico do pet.
 *
 * É o contrato que a agenda abre a cada ficha e que o agente de IA vai consumir
 * quando existir. Tudo o que está aqui já existe espalhado em outras telas; o valor
 * do endpoint é ser **uma** chamada com SLO de 150ms, em vez de cinco.
 *
 * `vaccinationStatus` sai `UNKNOWN` enquanto MOD-PRONT-08 não existir, e isso é
 * deliberado: "desconhecido" não é "em dia". Um resumo que afirmasse a segunda coisa
 * sem ter a tabela de vacinas mentiria exatamente no campo em que a mentira custa
 * caro — o serviço de creche que só deveria aceitar pet vacinado.
 */

export async function getClinicalSummary(
  tenantId: string,
  petId: string,
): Promise<PetClinicalSummary> {
  const cached = await cacheGet<PetClinicalSummary>(SUMMARY_KEY(tenantId, petId))
  if (cached) return cached

  const summary = await withTenant(tenantId, async (tx) => {
    const pet = await tx.pet.findFirst({ where: { id: petId }, select: { id: true } })
    if (!pet) throw notFound('Pet não encontrado')

    const cipher = await openCipher(tx, tenantId)
    const sources = await loadAlertSources(tx, petId)

    const twelveMonthsAgo = new Date()
    twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12)

    const [last, count12m] = await Promise.all([
      tx.attendance.findFirst({
        where: { petId, status: 'COMPLETED' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      tx.attendance.count({
        where: { petId, status: 'COMPLETED', startedAt: { gte: twelveMonthsAgo } },
      }),
    ])

    // RN-03: a bandeira é o que a agenda lê para decidir se bloqueia. Ela sai da
    // alergia CRÍTICA, e só dela — as demais severidades avisam, não impedem.
    const blockingFlags: string[] = []
    if (sources.allergies.some((allergy) => allergy.severity === 'CRITICAL')) {
      blockingFlags.push('ALLERGY_CRITICAL')
    }
    if (sources.temperament?.requiresTwoHandlers) blockingFlags.push('REQUIRES_TWO_HANDLERS')

    return {
      petId,
      activeAllergies: sources.allergies.map((allergy) => ({
        label: allergy.label,
        severity: allergy.severity,
        type: allergy.type,
      })),
      currentTemperament: sources.temperament
        ? {
            classification: sources.temperament.classification,
            requiresMuzzle: sources.temperament.requiresMuzzle,
            requiresTwoHandlers: sources.temperament.requiresTwoHandlers,
            contexts: sources.temperament.contexts,
          }
        : null,
      activeMedicalAlerts: sources.medicalAlerts.map((alert) => ({
        condition: alert.condition,
        severity: alert.severity,
        instructions: decryptOptional(cipher, alert.instructionsEncrypted),
      })),
      vaccinationStatus: 'UNKNOWN' as const,
      lastAttendanceAt: last?.startedAt.toISOString() ?? null,
      attendanceCount12m: count12m,
      blockingFlags,
    }
  })

  await cacheSet(SUMMARY_KEY(tenantId, petId), summary, SUMMARY_TTL_SECONDS)
  return summary
}
