import type { TenantTransaction } from '@petshop/db'
import {
  SEVERITY_ORDER,
  TEMPERAMENT_LABELS,
  type ClinicalSeverity,
  type PetAlert,
  type PetResponse,
} from '@petshop/shared-types'

/**
 * Alertas do prontuário na resposta do pet (RN-09 de pets_03).
 *
 * As tabelas são do **medical-record-service**, e lê-las daqui é acoplamento
 * assumido — o mesmo que o pet-service já faz com `tutors` e o tutor-service com
 * `pet_tutors`. A alternativa seria uma chamada HTTP em toda leitura de pet, num
 * endpoint com SLO de 200ms que também lista vinte pets de uma vez: vinte chamadas
 * síncronas para montar uma tela de balcão.
 *
 * A regra de **o que vira alerta** não está aqui: ela é clínica e vive no
 * `medical-record-service`. Isto é uma projeção de leitura, e a duplicação do mapa
 * de severidade do temperamento é o preço — deliberado — de não fazer a chamada.
 */

const TEMPERAMENT_SEVERITY: Record<string, ClinicalSeverity | null> = {
  AGGRESSIVE: 'CRITICAL',
  REACTIVE: 'HIGH',
  FEARFUL: 'MEDIUM',
  ANXIOUS: 'LOW',
  DOCILE: null,
  UNKNOWN: null,
}

/**
 * Preenche `alerts[]` nas respostas já mapeadas.
 *
 * Uma consulta por tabela para o lote inteiro, não por pet: a listagem de vinte pets
 * faz três consultas, não sessenta.
 */
export async function attachAlerts(
  tx: TenantTransaction,
  petIds: string[],
  responses: PetResponse[],
): Promise<PetResponse[]> {
  if (petIds.length === 0) return responses

  const [allergies, temperaments, medicalAlerts] = await Promise.all([
    tx.allergy.findMany({
      where: { petId: { in: petIds }, active: true },
      select: { petId: true, label: true, severity: true },
      orderBy: { createdAt: 'desc' },
    }),
    tx.temperament.findMany({
      where: { petId: { in: petIds }, isCurrent: true },
      select: {
        petId: true,
        classification: true,
        requiresMuzzle: true,
        requiresTwoHandlers: true,
      },
    }),
    tx.medicalAlert.findMany({
      where: { petId: { in: petIds }, active: true },
      select: { petId: true, condition: true, severity: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const byPet = new Map<string, PetAlert[]>()
  const push = (petId: string, alert: PetAlert): void => {
    const list = byPet.get(petId)
    if (list) list.push(alert)
    else byPet.set(petId, [alert])
  }

  for (const allergy of allergies) {
    push(allergy.petId, { type: 'ALLERGY', severity: allergy.severity, label: allergy.label })
  }

  for (const temperament of temperaments) {
    const severity = TEMPERAMENT_SEVERITY[temperament.classification]
    if (!severity) continue

    // O rótulo carrega o manejo: "Reativo · exige focinheira" diz ao banhista o que
    // fazer; "Reativo" sozinho manda ele adivinhar.
    const parts = [TEMPERAMENT_LABELS[temperament.classification] ?? temperament.classification]
    if (temperament.requiresMuzzle) parts.push('exige focinheira')
    if (temperament.requiresTwoHandlers) parts.push('exige dois profissionais')

    push(temperament.petId, { type: 'TEMPERAMENT', severity, label: parts.join(' · ') })
  }

  for (const alert of medicalAlerts) {
    push(alert.petId, { type: 'MEDICAL', severity: alert.severity, label: alert.condition })
  }

  for (const response of responses) {
    const alerts = byPet.get(response.id)
    if (!alerts) continue
    // Mais grave primeiro: quem lê a ficha em três segundos precisa achar o CRITICAL
    // no topo, não no fim de uma lista de sete.
    response.alerts = alerts.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
  }

  return responses
}
