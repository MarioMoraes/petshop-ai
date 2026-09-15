import { withTenant, type Allergy, type MedicalAlert, type Temperament, type TenantTransaction } from '@petshop/db'
import {
  RISK_TEMPERAMENTS,
  SEVERITY_ORDER,
  TEMPERAMENT_LABELS,
  type ClinicalSeverity,
  type PetAlert,
} from '@petshop/shared-types'

/**
 * Agregação de alertas (RN-09 de pets_03, RN-02 de prontuario_04).
 *
 * Este é o contrato que o resto do sistema consome: `GET /v1/pets/:id` embute
 * `alerts[]`, a agenda exibe antes de gravar e o check-in exige reconhecimento.
 * Três origens diferentes — alergia, temperamento e condição médica — viram uma
 * lista só, ordenada por severidade, porque quem está com o animal na frente não
 * quer três seções: quer saber o que é mais grave primeiro.
 *
 * Mora aqui, e não no pet-service, porque a regra de **o que vira alerta** é
 * clínica. O pet-service lê o resultado; quem decide que `REACTIVE` alerta e
 * `ANXIOUS` não é o prontuário.
 */

/**
 * Temperamento não tem coluna de severidade — a classificação **é** a severidade.
 * Agressivo é crítico porque a equipe pode se machucar; reativo é alto porque exige
 * manejo diferente; ansioso e medroso informam sem alarmar.
 */
const TEMPERAMENT_SEVERITY: Record<string, ClinicalSeverity | null> = {
  AGGRESSIVE: 'CRITICAL',
  REACTIVE: 'HIGH',
  FEARFUL: 'MEDIUM',
  ANXIOUS: 'LOW',
  DOCILE: null,
  UNKNOWN: null,
}

/** As classificações que viram alerta `CRITICAL` — lidas pelo indicador do Início. */
export const CRITICAL_TEMPERAMENTS: string[] = Object.entries(TEMPERAMENT_SEVERITY)
  .filter(([, severity]) => severity === 'CRITICAL')
  .map(([classification]) => classification)

export interface AlertSources {
  allergies: Allergy[]
  temperament: Temperament | null
  medicalAlerts: MedicalAlert[]
}

/** Só o que está ativo entra no alerta; o histórico é lido em outra tela. */
export async function loadAlertSources(
  tx: TenantTransaction,
  petId: string,
): Promise<AlertSources> {
  const [allergies, temperament, medicalAlerts] = await Promise.all([
    tx.allergy.findMany({ where: { petId, active: true }, orderBy: { createdAt: 'desc' } }),
    tx.temperament.findFirst({ where: { petId, isCurrent: true } }),
    tx.medicalAlert.findMany({ where: { petId, active: true }, orderBy: { createdAt: 'desc' } }),
  ])
  return { allergies, temperament, medicalAlerts }
}

export function toPetAlerts(sources: AlertSources): PetAlert[] {
  const alerts: PetAlert[] = []

  for (const allergy of sources.allergies) {
    alerts.push({ type: 'ALLERGY', severity: allergy.severity, label: allergy.label })
  }

  if (sources.temperament) {
    const severity = TEMPERAMENT_SEVERITY[sources.temperament.classification]
    if (severity) {
      alerts.push({
        type: 'TEMPERAMENT',
        severity,
        label: temperamentLabel(sources.temperament),
      })
    }
  }

  for (const alert of sources.medicalAlerts) {
    alerts.push({ type: 'MEDICAL', severity: alert.severity, label: alert.condition })
  }

  // Mais grave primeiro; entre iguais, a ordem de entrada. Quem lê a lista de cima
  // para baixo em três segundos precisa encontrar o CRITICAL no topo.
  return alerts.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
}

/**
 * O rótulo carrega o manejo, não só a classificação: "Reativo · exige focinheira"
 * diz ao banhista o que fazer. "Reativo" sozinho manda ele adivinhar.
 */
function temperamentLabel(temperament: Temperament): string {
  const parts = [TEMPERAMENT_LABELS[temperament.classification] ?? temperament.classification]
  if (temperament.requiresMuzzle) parts.push('exige focinheira')
  if (temperament.requiresTwoHandlers) parts.push('exige dois profissionais')
  return parts.join(' · ')
}

/** A maior severidade ativa, para o payload do evento e para o destaque da tela. */
export function highestSeverity(alerts: PetAlert[]): ClinicalSeverity | null {
  return alerts.reduce<ClinicalSeverity | null>((highest, alert) => {
    if (!highest) return alert.severity
    return SEVERITY_ORDER[alert.severity] > SEVERITY_ORDER[highest] ? alert.severity : highest
  }, null)
}

/** RN-16: já apresentou reatividade alguma vez, mesmo que hoje esteja dócil. */
export function hadRiskHistory(history: Temperament[]): boolean {
  return history.some((entry) =>
    RISK_TEMPERAMENTS.includes(entry.classification as (typeof RISK_TEMPERAMENTS)[number]),
  )
}

/** Atalho para quem só quer a lista pronta — usado pelo endpoint de alertas. */
export async function petAlerts(tenantId: string, petId: string): Promise<PetAlert[]> {
  return withTenant(tenantId, async (tx) => toPetAlerts(await loadAlertSources(tx, petId)))
}
