import { z } from 'zod'
import { PetAlertSchema } from './pet.js'

/**
 * MOD-PRONT-03/04/05 — contratos do prontuário de segurança.
 *
 * O recorte é deliberado: alergia, temperamento e alerta médico são o que a equipe
 * precisa saber **antes de encostar no pet**. O registro de atendimento
 * (MOD-PRONT-01) nasce do check-out da agenda e entra com MOD-AGENDA.
 *
 * A severidade é o eixo: `CRITICAL` bloqueia de forma suave (exige reconhecimento
 * explícito, RN-03), os demais níveis avisam. Nada aqui impede o atendimento — a
 * decisão é sempre de quem está com o animal na frente.
 */

export const ClinicalSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
export type ClinicalSeverity = z.infer<typeof ClinicalSeveritySchema>

/** Ordem de exibição e de comparação. Maior índice = mais grave. */
export const SEVERITY_ORDER: Record<ClinicalSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
}

export const SEVERITY_LABELS: Record<ClinicalSeverity, string> = {
  LOW: 'Leve',
  MEDIUM: 'Moderada',
  HIGH: 'Alta',
  CRITICAL: 'Crítica',
}

// ─── Alergias e restrições (MOD-PRONT-03) ────────────────────────────────────

export const AllergyTypeSchema = z.enum([
  'FOOD',
  'PRODUCT',
  'MEDICATION',
  'ENVIRONMENTAL',
  'OTHER',
])
export type AllergyType = z.infer<typeof AllergyTypeSchema>

export const ALLERGY_TYPE_LABELS: Record<AllergyType, string> = {
  FOOD: 'Alimento',
  PRODUCT: 'Produto',
  MEDICATION: 'Medicamento',
  ENVIRONMENTAL: 'Ambiental',
  OTHER: 'Outra',
}

export const CreateAllergySchema = z.object({
  type: AllergyTypeSchema,
  label: z.string().min(2).max(120),
  severity: ClinicalSeveritySchema,
  reaction: z.string().max(1000).optional(),
  /** Serviços que esta alergia bloqueia (RN-03). Ids do catálogo do MOD-AGENDA. */
  blocksServices: z.array(z.uuid()).default([]),
  /** Palavras-chave de produto, casadas no check-out ("shampoo neutro X"). */
  blocksProducts: z.array(z.string().min(2).max(80)).default([]),
  diagnosedAt: z.iso.date().optional(),
})
export type CreateAllergyInput = z.output<typeof CreateAllergySchema>

/**
 * A desativação é uma operação com justificativa, não um `active: false` solto:
 * AC-04 exige saber por que uma alergia deixou de valer, e quem decidiu isso.
 */
export const UpdateAllergySchema = z
  .object({
    severity: ClinicalSeveritySchema,
    reaction: z.string().max(1000).nullable(),
    blocksServices: z.array(z.uuid()),
    blocksProducts: z.array(z.string().min(2).max(80)),
    active: z.boolean(),
    resolutionNotes: z.string().max(500),
  })
  .partial()
  .refine((data) => data.active !== false || (data.resolutionNotes?.trim().length ?? 0) >= 10, {
    message: 'Explique por que a alergia deixou de valer — a equipe vai confiar nisso',
    path: ['resolutionNotes'],
  })
export type UpdateAllergyInput = z.output<typeof UpdateAllergySchema>

export const AllergySchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  type: AllergyTypeSchema,
  label: z.string(),
  severity: ClinicalSeveritySchema,
  reaction: z.string().nullable(),
  blocksServices: z.array(z.uuid()),
  blocksProducts: z.array(z.string()),
  diagnosedAt: z.iso.date().nullable(),
  active: z.boolean(),
  resolutionNotes: z.string().nullable(),
  deactivatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type Allergy = z.infer<typeof AllergySchema>

// ─── Temperamento (MOD-PRONT-04) ─────────────────────────────────────────────

export const TemperamentClassificationSchema = z.enum([
  'DOCILE',
  'ANXIOUS',
  'FEARFUL',
  'REACTIVE',
  'AGGRESSIVE',
  'UNKNOWN',
])
export type TemperamentClassification = z.infer<typeof TemperamentClassificationSchema>

export const TEMPERAMENT_LABELS: Record<TemperamentClassification, string> = {
  DOCILE: 'Dócil',
  ANXIOUS: 'Ansioso',
  FEARFUL: 'Medroso',
  REACTIVE: 'Reativo',
  AGGRESSIVE: 'Agressivo',
  UNKNOWN: 'Não avaliado',
}

/** As classificações que exigem contexto escrito (AC-02) e que viram alerta. */
export const RISK_TEMPERAMENTS = ['REACTIVE', 'AGGRESSIVE'] as const

export const TEMPERAMENT_CONTEXTS = [
  'NAIL_TRIMMING',
  'DRYER',
  'MUZZLE',
  'BATH',
  'STRANGERS',
  'OTHER_DOGS',
] as const
export type TemperamentContext = (typeof TEMPERAMENT_CONTEXTS)[number]

export const TEMPERAMENT_CONTEXT_LABELS: Record<TemperamentContext, string> = {
  NAIL_TRIMMING: 'Corte de unhas',
  DRYER: 'Secador',
  MUZZLE: 'Focinheira',
  BATH: 'Banho',
  STRANGERS: 'Estranhos',
  OTHER_DOGS: 'Outros cães',
}

export const RecordTemperamentSchema = z
  .object({
    classification: TemperamentClassificationSchema,
    contexts: z.array(z.enum(TEMPERAMENT_CONTEXTS)).default([]),
    notes: z.string().max(1000).optional(),
    requiresMuzzle: z.boolean().default(false),
    requiresTwoHandlers: z.boolean().default(false),
  })
  // AC-02: "morde" sem contexto não diz à equipe o que evitar.
  .refine(
    (data) =>
      !RISK_TEMPERAMENTS.includes(data.classification as (typeof RISK_TEMPERAMENTS)[number]) ||
      (data.notes?.trim().length ?? 0) >= 10,
    {
      message: 'Descreva o contexto — a equipe precisa saber o que evitar',
      path: ['notes'],
    },
  )
export type RecordTemperamentInput = z.output<typeof RecordTemperamentSchema>

export const TemperamentSchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  classification: TemperamentClassificationSchema,
  contexts: z.array(z.string()),
  requiresMuzzle: z.boolean(),
  requiresTwoHandlers: z.boolean(),
  notes: z.string().nullable(),
  observedAt: z.iso.datetime(),
  isCurrent: z.boolean(),
})
export type Temperament = z.infer<typeof TemperamentSchema>

/**
 * AC-03: o vigente manda, mas o passado não some.
 *
 * `hadRiskHistory` é o "já apresentou reatividade" da ficha: um pet dócil hoje que
 * mordeu há dois anos continua sendo um pet que mordeu. Esconder isso porque a
 * última observação foi boa é exatamente o defeito que o AC existe para impedir.
 */
export const TemperamentHistorySchema = z.object({
  current: TemperamentSchema.nullable(),
  history: z.array(TemperamentSchema),
  hadRiskHistory: z.boolean(),
})
export type TemperamentHistory = z.infer<typeof TemperamentHistorySchema>

// ─── Alertas médicos (MOD-PRONT-05) ──────────────────────────────────────────

export const CreateMedicalAlertSchema = z.object({
  condition: z.string().min(2).max(120),
  severity: ClinicalSeveritySchema,
  /** "Não usar secador quente" — instrução de execução, não diagnóstico. */
  instructions: z.string().max(1000).optional(),
})
export type CreateMedicalAlertInput = z.output<typeof CreateMedicalAlertSchema>

export const UpdateMedicalAlertSchema = z
  .object({
    severity: ClinicalSeveritySchema,
    instructions: z.string().max(1000).nullable(),
    active: z.boolean(),
    resolutionNotes: z.string().max(500),
  })
  .partial()
  .refine((data) => data.active !== false || (data.resolutionNotes?.trim().length ?? 0) >= 10, {
    message: 'Explique por que a condição deixou de valer',
    path: ['resolutionNotes'],
  })
export type UpdateMedicalAlertInput = z.output<typeof UpdateMedicalAlertSchema>

export const MedicalAlertSchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  condition: z.string(),
  severity: ClinicalSeveritySchema,
  instructions: z.string().nullable(),
  active: z.boolean(),
  resolutionNotes: z.string().nullable(),
  deactivatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type MedicalAlert = z.infer<typeof MedicalAlertSchema>

// ─── Visão consolidada ───────────────────────────────────────────────────────

/** O que a aba "Prontuário" do pet carrega de uma vez. */
export const SafetyRecordSchema = z.object({
  allergies: z.array(AllergySchema),
  temperament: TemperamentHistorySchema,
  medicalAlerts: z.array(MedicalAlertSchema),
  /** O mesmo agregado que `GET /v1/pets/:id` devolve (RN-09 de pets_03). */
  alerts: z.array(PetAlertSchema),
})
export type SafetyRecord = z.infer<typeof SafetyRecordSchema>

/**
 * RN-03/RN-04 — o serviço esbarra em alguma alergia deste pet?
 *
 * Existe como endpoint próprio porque quem pergunta é o MOD-AGENDA, antes de gravar
 * o agendamento, e a resposta precisa distinguir três casos: livre, avisa, bloqueia.
 */
export const AllergyCheckSchema = z.object({
  serviceIds: z.array(z.uuid()).min(1),
})

export const AllergyCheckResultSchema = z.object({
  /** `true` quando existe alergia CRITICAL bloqueando algum dos serviços. */
  blocked: z.boolean(),
  blocking: z.array(AllergySchema),
  /** MEDIUM e HIGH: passa com `acknowledged`, mas a tela mostra em destaque. */
  warnings: z.array(AllergySchema),
})
export type AllergyCheckResult = z.infer<typeof AllergyCheckResultSchema>
