import { withTenant } from '@petshop/db'
import type { CriticalPets } from '@petshop/shared-types'
import { CRITICAL_TEMPERAMENTS } from './alerts.js'

interface CriticalRow {
  pets: bigint
  by_allergy: bigint
  by_temperament: bigint
  by_medical: bigint
}

/**
 * Pets com alerta crítico ativo — o indicador de segurança da equipe (PRD prontuario_04
 * §10), no painel do Início.
 *
 * **O que é crítico não se decide aqui.** Alergia e condição médica têm severidade
 * gravada; temperamento não tem, e a classificação é traduzida por `alerts.ts`, que é o
 * mesmo mapa que monta o alerta da ficha. Reescrever "agressivo é crítico" nesta
 * consulta criaria uma segunda regra que um dia discordaria da primeira — e o painel
 * contaria um pet que a ficha não destaca.
 *
 * Conta pets **não terminais**: o inativo é o cliente que sumiu e pode voltar amanhã
 * com a mesma alergia. Falecido e transferido não entram mais no salão.
 */
export async function criticalPets(tenantId: string): Promise<CriticalPets> {
  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx.$queryRaw<CriticalRow[]>`
      SELECT COUNT(*) FILTER (WHERE allergy OR temperament OR medical) AS pets,
             COUNT(*) FILTER (WHERE allergy) AS by_allergy,
             COUNT(*) FILTER (WHERE temperament) AS by_temperament,
             COUNT(*) FILTER (WHERE medical) AS by_medical
        FROM (
               SELECT EXISTS (
                        SELECT 1 FROM allergies a
                         WHERE a.pet_id = p.id AND a.active AND a.severity = 'CRITICAL'
                      ) AS allergy,
                      EXISTS (
                        SELECT 1 FROM temperaments t
                         WHERE t.pet_id = p.id
                           AND t.is_current
                           AND t.classification::text = ANY(${CRITICAL_TEMPERAMENTS}::text[])
                      ) AS temperament,
                      EXISTS (
                        SELECT 1 FROM medical_alerts m
                         WHERE m.pet_id = p.id AND m.active AND m.severity = 'CRITICAL'
                      ) AS medical
                 FROM pets p
                WHERE p.tenant_id = ${tenantId}::uuid
                  AND p.status IN ('ACTIVE', 'INACTIVE')
             ) flags
    `,
  )

  const row = rows[0]
  return {
    pets: Number(row?.pets ?? 0),
    byAllergy: Number(row?.by_allergy ?? 0),
    byTemperament: Number(row?.by_temperament ?? 0),
    byMedical: Number(row?.by_medical ?? 0),
  }
}
