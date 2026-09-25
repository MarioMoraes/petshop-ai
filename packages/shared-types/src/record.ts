import { z } from 'zod'
import { PetAlertSchema } from './pet.js'

/**
 * MOD-PRONT — contratos do prontuário.
 *
 * Duas metades. A de cima é o prontuário de **segurança** (03/04/05): alergia,
 * temperamento e alerta médico — o que a equipe precisa saber antes de encostar no
 * pet. A de baixo é o **atendimento** (01/02/09/10): o registro do que foi feito,
 * sua linha do tempo e as regras de correção.
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

export const AllergyTypeSchema = z.enum(['FOOD', 'PRODUCT', 'MEDICATION', 'ENVIRONMENTAL', 'OTHER'])
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

// ─── Atendimento (MOD-PRONT-01, 09, 10) ──────────────────────────────────────

/**
 * O registro do que foi feito com o animal.
 *
 * Ele **não nasce de um POST**: nasce do check-in da agenda, em `DRAFT`, e fecha no
 * check-out. Os schemas de escrita abaixo são todos de *depois* — corrigir, anexar
 * adendo, anotar durante a execução, anular. É a consequência de o atendimento ser
 * um fato da operação, não um formulário: quem o cria é o balcão, ao mover o pet
 * pelo dia, e não alguém digitando um cadastro.
 */

export const AttendanceTypeSchema = z.enum([
  'GROOMING',
  'BATH',
  'VET_CONSULT',
  'VACCINE',
  'PROCEDURE',
  'DAYCARE',
  'OTHER',
])
export type AttendanceType = z.infer<typeof AttendanceTypeSchema>

export const ATTENDANCE_TYPE_LABELS: Record<AttendanceType, string> = {
  GROOMING: 'Tosa',
  BATH: 'Banho',
  VET_CONSULT: 'Consulta',
  VACCINE: 'Vacina',
  PROCEDURE: 'Procedimento',
  DAYCARE: 'Creche',
  OTHER: 'Outro',
}

export const AttendanceOriginSchema = z.enum(['SCHEDULED', 'WALK_IN', 'RETROACTIVE'])
export type AttendanceOrigin = z.infer<typeof AttendanceOriginSchema>

export const ATTENDANCE_ORIGIN_LABELS: Record<AttendanceOrigin, string> = {
  SCHEDULED: 'Agendado',
  WALK_IN: 'Encaixe',
  RETROACTIVE: 'Lançado depois',
}

export const AttendanceStatusSchema = z.enum(['DRAFT', 'COMPLETED', 'VOIDED'])
export type AttendanceStatus = z.infer<typeof AttendanceStatusSchema>

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  DRAFT: 'Em atendimento',
  COMPLETED: 'Concluído',
  VOIDED: 'Anulado',
}

export const AttendanceNoteKindSchema = z.enum(['ADDENDUM', 'OPERATIONAL'])
export type AttendanceNoteKind = z.infer<typeof AttendanceNoteKindSchema>

export const AttendanceNoteVisibilitySchema = z.enum(['INTERNAL', 'TUTOR_VISIBLE'])
export type AttendanceNoteVisibility = z.infer<typeof AttendanceNoteVisibilitySchema>

export const AttendancePhaseSchema = z.enum(['BEFORE', 'AFTER'])
export type AttendancePhase = z.infer<typeof AttendancePhaseSchema>

/**
 * RN-11: o lote é o que liga uma reação de terça ao shampoo de segunda.
 *
 * `name` e `batch` são o **retrato** do dia e continuam obrigatórios na leitura: o
 * prontuário não depende do cadastro de estoque. Com o MOD-ESTOQUE, a linha pode também
 * apontar o produto e o lote de verdade (`productId`, `lotId`, `quantity`). Aí a edição
 * do atendimento dá baixa no lote pela diferença, e a anulação devolve. A linha só de
 * texto continua valendo e não mexe em estoque.
 */
export const ProductUsedSchema = z.object({
  name: z.string().min(1).max(120),
  batch: z.string().max(60).optional(),
  productId: z.uuid().optional(),
  lotId: z.uuid().optional(),
  /** Quantidade em string decimal, como todo o estoque. Sem ela a linha não baixa nada. */
  quantity: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim().replace(',', '.'))
    .refine((value) => /^\d{1,9}(\.\d{1,3})?$/.test(value) && Number(value) > 0, {
      message: 'Informe a quantidade usada',
    })
    .optional(),
})
export type ProductUsed = z.infer<typeof ProductUsedSchema>

export const AttendanceItemSchema = z.object({
  id: z.uuid(),
  serviceId: z.uuid(),
  /** Fotografia do nome (RN-07): o histórico sobrevive ao serviço renomeado. */
  label: z.string(),
  executedBy: z.uuid(),
  unitPriceCents: z.number().int(),
  quantity: z.number().int(),
  totalPriceCents: z.number().int(),
  notes: z.string().nullable(),
  productsUsed: z.array(ProductUsedSchema),
})
export type AttendanceItem = z.infer<typeof AttendanceItemSchema>

export const AttendanceNoteSchema = z.object({
  id: z.uuid(),
  kind: AttendanceNoteKindSchema,
  visibility: AttendanceNoteVisibilitySchema,
  body: z.string(),
  version: z.number().int(),
  authorId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
})
export type AttendanceNote = z.infer<typeof AttendanceNoteSchema>

export const AttendanceSchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  tutorId: z.uuid(),
  appointmentId: z.uuid().nullable(),
  type: AttendanceTypeSchema,
  origin: AttendanceOriginSchema,
  performedBy: z.uuid(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  observations: z.string().nullable(),
  weightKg: z.number().nullable(),
  status: AttendanceStatusSchema,
  voidReason: z.string().nullable(),
  voidedAt: z.iso.datetime().nullable(),
  /** `finished_at + 24h`. Nulo enquanto rascunho. */
  editableUntil: z.iso.datetime().nullable(),
  /** Derivado, não coluna: é o que a tela usa para escolher entre editar e adendar. */
  editable: z.boolean(),
  version: z.number().int(),
  totalCents: z.number().int(),
  items: z.array(AttendanceItemSchema),
  notes: z.array(AttendanceNoteSchema),
  createdAt: z.iso.datetime(),
})
export type Attendance = z.infer<typeof AttendanceSchema>

/**
 * Correção dentro da janela de 24h (AC-01 do §09).
 *
 * O que se corrige é o que se digitou com o cliente na frente — observação e nota de
 * item. Preço, pet e profissional não entram: mudar qualquer um deles é outro
 * atendimento, e o caminho para isso é anular e registrar de novo.
 */
export const UpdateAttendanceSchema = z
  .object({
    observations: z.string().max(4000).nullish(),
    type: AttendanceTypeSchema.optional(),
    items: z
      .array(
        z.object({
          id: z.uuid(),
          executedBy: z.uuid().optional(),
          notes: z.string().max(500).nullish(),
          productsUsed: z.array(ProductUsedSchema).optional(),
        }),
      )
      .optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'Informe ao menos um campo para atualizar',
  })
export type UpdateAttendanceInput = z.output<typeof UpdateAttendanceSchema>

/** AC-02 do §09: passadas as 24h, corrigir é acrescentar, nunca sobrescrever. */
export const AddendumSchema = z.object({
  body: z.string().min(10).max(4000),
  visibility: AttendanceNoteVisibilitySchema.default('INTERNAL'),
})
export type AddendumInput = z.output<typeof AddendumSchema>

/** MOD-PRONT-10: a nota rápida de quem está com o pet na mão, durante a execução. */
export const OperationalNoteSchema = z.object({
  body: z.string().min(1).max(1000),
  visibility: AttendanceNoteVisibilitySchema.default('INTERNAL'),
})
export type OperationalNoteInput = z.output<typeof OperationalNoteSchema>

/**
 * AC-03 do §09 — anulação.
 *
 * O motivo é obrigatório e longo de propósito: um registro riscado sem explicação é
 * pior do que o registro errado, porque ninguém depois sabe se foi engano de digitação
 * ou serviço que não aconteceu — e o ledger estorna dinheiro com base nisso.
 */
export const VoidAttendanceSchema = z.object({
  reason: z.string().min(10).max(500),
})
export type VoidAttendanceInput = z.output<typeof VoidAttendanceSchema>

/**
 * Registro lançado à mão (AC-03 do §01, caminho de reparo).
 *
 * O encaixe do dia a dia **não** passa por aqui: ele entra pela agenda, em
 * `POST /v1/appointments/walk-in`, que cria o agendamento retroativo e conclui —
 * e o atendimento nasce do evento como qualquer outro. Este endpoint existe para o
 * caso em que o atendimento aconteceu, o agendamento está lá e o registro não veio.
 */
export const CreateAttendanceSchema = z
  .object({
    petId: z.uuid(),
    appointmentId: z.uuid().optional(),
    type: AttendanceTypeSchema,
    performedBy: z.uuid(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    observations: z.string().max(4000).optional(),
    weightKg: z.number().min(0.05).max(120).optional(),
    items: z
      .array(
        z.object({
          serviceId: z.uuid(),
          executedBy: z.uuid(),
          quantity: z.number().int().min(1).default(1),
          unitPriceCents: z.number().int().min(0),
          notes: z.string().max(500).optional(),
          productsUsed: z.array(ProductUsedSchema).default([]),
        }),
      )
      .min(1),
  })
  .refine((input) => new Date(input.finishedAt) > new Date(input.startedAt), {
    message: 'O término deve ser posterior ao início',
    path: ['finishedAt'],
  })
export type CreateAttendanceInput = z.output<typeof CreateAttendanceSchema>

export const ListAttendancesQuerySchema = z.object({
  petId: z.uuid().optional(),
  /** Como a tela de check-out acha o rascunho aberto pelo check-in. */
  appointmentId: z.uuid().optional(),
  professionalId: z.uuid().optional(),
  type: AttendanceTypeSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})
export type ListAttendancesQuery = z.output<typeof ListAttendancesQuerySchema>

// ─── Linha do tempo (MOD-PRONT-02) ───────────────────────────────────────────

/**
 * Os tipos de evento que a linha do tempo unifica.
 *
 * A lista é fechada porque o filtro por papel (AC-02) é feito sobre ela: quem tem só
 * `record:read_alerts` vê o subconjunto operacional, e um tipo novo que entrasse sem
 * ser classificado apareceria para todo mundo por omissão — que é o erro que a regra
 * "filtrado no servidor, jamais apenas na UI" existe para impedir.
 */
export const TIMELINE_KINDS = [
  'ATTENDANCE',
  'WEIGHT',
  'ALLERGY',
  'TEMPERAMENT',
  'MEDICAL_ALERT',
  'PHOTO',
  'TRANSFER',
] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]

/** O que o banhista e o tosador enxergam: segurança e execução, não diagnóstico. */
export const OPERATIONAL_TIMELINE_KINDS: readonly TimelineKind[] = [
  'ATTENDANCE',
  'WEIGHT',
  'ALLERGY',
  'TEMPERAMENT',
  'PHOTO',
]

export const TimelineEntrySchema = z.object({
  kind: z.enum(TIMELINE_KINDS),
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  title: z.string(),
  detail: z.string().nullable(),
  /** `VOIDED` num atendimento é o que a tela risca. */
  status: z.string().nullable(),
  severity: ClinicalSeveritySchema.nullable(),
  /** Payload específico do tipo — a tela decide o que fazer com ele. */
  meta: z.record(z.string(), z.unknown()),
})
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>

export const TimelinePageSchema = z.object({
  entries: z.array(TimelineEntrySchema),
  /** Opaco: `occurredAt|id`, em base64. Nulo quando acabou. */
  nextCursor: z.string().nullable(),
})
export type TimelinePage = z.infer<typeof TimelinePageSchema>

export const TimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  kinds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : (Array.isArray(value) ? value : value.split(','))
            .map((item) => item.trim())
            .filter((item): item is TimelineKind =>
              (TIMELINE_KINDS as readonly string[]).includes(item),
            ),
    ),
})
export type TimelineQuery = z.output<typeof TimelineQuerySchema>

// ─── Resumo clínico (MOD-PRONT-11) ───────────────────────────────────────────

/**
 * O sumário que a agenda abre a cada ficha e que o agente de IA vai consumir.
 *
 * `vaccinationStatus` sai `UNKNOWN` enquanto MOD-PRONT-08 não existir — e é honesto
 * assim: "desconhecido" não é "em dia", e um resumo que afirmasse a segunda coisa
 * sem ter a tabela mentiria justamente no campo em que a mentira custa caro.
 */
export const PetClinicalSummarySchema = z.object({
  petId: z.uuid(),
  activeAllergies: z.array(
    z.object({ label: z.string(), severity: ClinicalSeveritySchema, type: AllergyTypeSchema }),
  ),
  currentTemperament: z
    .object({
      classification: TemperamentClassificationSchema,
      requiresMuzzle: z.boolean(),
      requiresTwoHandlers: z.boolean(),
      contexts: z.array(z.string()),
    })
    .nullable(),
  activeMedicalAlerts: z.array(
    z.object({
      condition: z.string(),
      severity: ClinicalSeveritySchema,
      instructions: z.string().nullable(),
    }),
  ),
  vaccinationStatus: z.enum(['UP_TO_DATE', 'DUE_SOON', 'OVERDUE', 'UNKNOWN']),
  lastAttendanceAt: z.iso.datetime().nullable(),
  attendanceCount12m: z.number().int(),
  /** Ex.: `["ALLERGY_CRITICAL"]`. É o que a agenda lê para decidir se bloqueia. */
  blockingFlags: z.array(z.string()),
})
export type PetClinicalSummary = z.infer<typeof PetClinicalSummarySchema>

// ─── Pets com alerta crítico (painel do Início) ──────────────────────────────

/**
 * Quantos pets têm hoje um alerta `CRITICAL` ativo, e de que origem.
 *
 * `pets` não é a soma das origens: o pet agressivo com alergia crítica conta uma vez em
 * `pets` e uma vez em cada origem. A origem desce junto porque o número sozinho não diz
 * o que fazer — alergia se resolve no serviço oferecido, temperamento em quem atende.
 */
export const CriticalPetsSchema = z.object({
  pets: z.number().int(),
  byAllergy: z.number().int(),
  byTemperament: z.number().int(),
  byMedical: z.number().int(),
})
export type CriticalPets = z.infer<typeof CriticalPetsSchema>
