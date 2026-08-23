import { z } from 'zod'

/**
 * PRD pets_03 §5 — contratos de entrada e saída do pet-service.
 *
 * RN-01 é o eixo do módulo: espécie, raça, porte e pelagem **nunca** são texto livre.
 * Todo campo de domínio aqui é um UUID que aponta para o catálogo — é o que torna o
 * preço calculável, o relatório agregável e o contexto do agente de IA estruturado.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

export const PetSexSchema = z.enum(['MALE', 'FEMALE', 'UNKNOWN'])
export type PetSex = z.infer<typeof PetSexSchema>

export const PetStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'DECEASED', 'TRANSFERRED_OUT'])
export type PetStatus = z.infer<typeof PetStatusSchema>

/** AC-03 de MOD-PET-01: pet resgatado tem idade estimada, não data de nascimento. */
export const BirthDatePrecisionSchema = z.enum(['EXACT', 'ESTIMATED', 'UNKNOWN'])
export type BirthDatePrecision = z.infer<typeof BirthDatePrecisionSchema>

export const PetTutorRoleSchema = z.enum(['PRIMARY', 'SECONDARY'])
export type PetTutorRole = z.infer<typeof PetTutorRoleSchema>

export const TransferReasonSchema = z.enum([
  'ADOPTION',
  'SALE',
  'TUTOR_DEATH',
  'CORRECTION',
  'OTHER',
])
export type TransferReason = z.infer<typeof TransferReasonSchema>

// ─── Catálogo de domínio (MOD-PET-03) ────────────────────────────────────────

export const SpeciesSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  /** `false` = item do catálogo global; `true` = criado por este tenant. */
  custom: z.boolean(),
})
export type Species = z.infer<typeof SpeciesSchema>

export const BreedSchema = z.object({
  id: z.uuid(),
  speciesId: z.uuid(),
  label: z.string(),
  /** Sugestão de porte ao selecionar a raça; a recepção pode trocar. */
  defaultSizeId: z.uuid().nullable(),
  groomingNotes: z.string().nullable(),
  custom: z.boolean(),
})
export type Breed = z.infer<typeof BreedSchema>

export const SizeSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  weightMinKg: z.number(),
  weightMaxKg: z.number(),
  custom: z.boolean(),
})
export type Size = z.infer<typeof SizeSchema>

export const CoatSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  /** RN-03: multiplica a duração base do serviço de banho e tosa. */
  groomingTimeFactor: z.number(),
  custom: z.boolean(),
})
export type Coat = z.infer<typeof CoatSchema>

/**
 * Chaves do catálogo global. O seed é a fonte; estas constantes existem para que
 * teste e regra de negócio não dependam de UUID semeado.
 */
export const SPECIES_KEYS = ['DOG', 'CAT', 'BIRD', 'RODENT', 'REPTILE', 'OTHER'] as const
export type SpeciesKey = (typeof SPECIES_KEYS)[number]

export const SIZE_KEYS = ['SMALL', 'MEDIUM', 'LARGE', 'GIANT'] as const
export type SizeKey = (typeof SIZE_KEYS)[number]

export const COAT_KEYS = ['SHORT', 'LONG', 'DOUBLE', 'CURLY', 'HAIRLESS'] as const
export type CoatKey = (typeof COAT_KEYS)[number]

/**
 * Normalização usada no dedupe de raça (AC-03 de MOD-PET-03): minúsculas, sem
 * acento e sem espaço redundante. "Golden Retriever" e "golden retriever" são a
 * mesma raça; guardar as duas quebraria o relatório por raça.
 */
export function normalizeBreedLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Idade (MOD-PET-06) ──────────────────────────────────────────────────────

/**
 * Meses completos entre duas datas, em UTC.
 *
 * `birth_date` é coluna `DATE` — sem hora e sem fuso. Calcular com os componentes
 * locais faria a idade do pet mudar conforme o fuso de quem consulta, e um pet
 * nascido dia 1º apareceria com um mês a menos para metade do país.
 */
export function monthsBetween(from: Date, to: Date): number {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  if (to.getUTCDate() < from.getUTCDate()) months -= 1
  return Math.max(months, 0)
}

/** Data de nascimento derivada da idade estimada (AC-03 de MOD-PET-01). */
export function birthDateFromEstimatedAge(ageMonths: number, reference = new Date()): string {
  const derived = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - ageMonths, reference.getUTCDate()),
  )
  return derived.toISOString().slice(0, 10)
}

/**
 * Rótulo de idade para a tela. O `≈` de idade estimada não é enfeite: distingue o
 * pet cuja carteira de vacinação traz a data do pet resgatado cuja idade o
 * veterinário chutou pelos dentes — e é isso que a dosagem clínica precisa saber.
 */
export function formatAgeLabel(
  ageMonths: number | null,
  precision: BirthDatePrecision,
): string | null {
  if (ageMonths === null || precision === 'UNKNOWN') return null

  const prefix = precision === 'ESTIMATED' ? '≈ ' : ''
  if (ageMonths < 1) return `${prefix}menos de 1 mês`
  if (ageMonths < 24) return `${prefix}${ageMonths} ${ageMonths === 1 ? 'mês' : 'meses'}`

  const years = Math.floor(ageMonths / 12)
  const months = ageMonths % 12
  const yearPart = `${years} ${years === 1 ? 'ano' : 'anos'}`
  if (months === 0) return `${prefix}${yearPart}`
  return `${prefix}${yearPart} e ${months} ${months === 1 ? 'mês' : 'meses'}`
}

// ─── Avisos não bloqueantes ──────────────────────────────────────────────────

/**
 * AC-04 de MOD-PET-01: peso incompatível com o porte **avisa**, nunca bloqueia.
 * O balcão precisa registrar a exceção real — o buldogue de 32 kg existe.
 */
export const PetWarningCodeSchema = z.enum(['WEIGHT_SIZE_MISMATCH'])
export type PetWarningCode = z.infer<typeof PetWarningCodeSchema>

export const PetWarningSchema = z.object({
  code: PetWarningCodeSchema,
  message: z.string(),
})
export type PetWarning = z.infer<typeof PetWarningSchema>

// ─── Vínculo pet ↔ tutor (MOD-PET-02) ────────────────────────────────────────

export const PetTutorInputSchema = z.object({
  tutorId: z.uuid(),
  role: PetTutorRoleSchema,
  relationship: z.string().max(40).optional(),
  canAuthorizeProcedures: z.boolean().default(true),
})
export type PetTutorInput = z.output<typeof PetTutorInputSchema>

export const LinkTutorSchema = PetTutorInputSchema
export type LinkTutorInput = PetTutorInput

export const UpdatePetTutorSchema = z
  .object({
    role: PetTutorRoleSchema,
    relationship: z.string().max(40).nullable(),
    canAuthorizeProcedures: z.boolean(),
  })
  .partial()
export type UpdatePetTutorInput = z.output<typeof UpdatePetTutorSchema>

export const PetTutorSchema = z.object({
  linkId: z.uuid(),
  tutorId: z.uuid(),
  fullName: z.string(),
  phoneMasked: z.string(),
  role: PetTutorRoleSchema,
  relationship: z.string().nullable(),
  canAuthorizeProcedures: z.boolean(),
  linkedAt: z.iso.datetime(),
})
export type PetTutorLink = z.infer<typeof PetTutorSchema>

// ─── Pet ─────────────────────────────────────────────────────────────────────

const PetCoreSchema = z.object({
  name: z.string().min(1).max(60),
  speciesId: z.uuid(),
  breedId: z.uuid().optional(),
  sizeId: z.uuid(),
  coatId: z.uuid().optional(),
  sex: PetSexSchema.default('UNKNOWN'),
  birthDate: z.iso.date().optional(),
  estimatedAgeMonths: z.number().int().min(0).max(360).optional(),
  weightKg: z.number().min(0.05).max(120).optional(),
  neutered: z.boolean().optional(),
  microchip: z
    .string()
    .transform((value) => value.replace(/\D/g, ''))
    .refine((value) => /^\d{15}$/.test(value), 'Microchip deve ter 15 dígitos')
    .optional(),
  color: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
})

export const CreatePetSchema = PetCoreSchema.extend({
  tutors: z
    .array(PetTutorInputSchema)
    .min(1)
    .refine(
      (list) => list.filter((tutor) => tutor.role === 'PRIMARY').length === 1,
      'Informe exatamente um responsável principal',
    )
    .refine(
      (list) => new Set(list.map((tutor) => tutor.tutorId)).size === list.length,
      'O mesmo tutor foi informado mais de uma vez',
    ),
}).refine((data) => Boolean(data.birthDate) || data.estimatedAgeMonths !== undefined, {
  message: 'Informe a data de nascimento ou a idade estimada',
  path: ['birthDate'],
})
export type CreatePetInput = z.output<typeof CreatePetSchema>

/**
 * O PATCH aceita `null` para limpar campo opcional — distinguir "não mandei" de
 * "quero apagar" é a diferença entre um PATCH e um PUT disfarçado.
 *
 * `status` só admite ACTIVE e INACTIVE: o óbito tem regra própria e efeitos
 * colaterais que um PATCH genérico não deve disparar por acidente (MOD-PET-08).
 */
export const UpdatePetSchema = z
  .object({
    name: z.string().min(1).max(60),
    speciesId: z.uuid(),
    breedId: z.uuid().nullable(),
    sizeId: z.uuid(),
    coatId: z.uuid().nullable(),
    sex: PetSexSchema,
    birthDate: z.iso.date().nullable(),
    estimatedAgeMonths: z.number().int().min(0).max(360).nullable(),
    weightKg: z.number().min(0.05).max(120).nullable(),
    neutered: z.boolean().nullable(),
    microchip: z
      .string()
      .transform((value) => value.replace(/\D/g, ''))
      .refine((value) => /^\d{15}$/.test(value), 'Microchip deve ter 15 dígitos')
      .nullable(),
    color: z.string().max(40).nullable(),
    notes: z.string().max(2000).nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .partial()
export type UpdatePetInput = z.output<typeof UpdatePetSchema>

const DomainRefSchema = z.object({ id: z.uuid(), key: z.string(), label: z.string() })

/** RN-09: alerta agregado do prontuário, exibido no agendamento e no check-in. */
export const PetAlertSchema = z.object({
  type: z.enum(['ALLERGY', 'TEMPERAMENT', 'MEDICAL']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  label: z.string(),
})
export type PetAlert = z.infer<typeof PetAlertSchema>

export const PetResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string(),
  species: DomainRefSchema,
  breed: z.object({ id: z.uuid(), label: z.string() }).nullable(),
  size: DomainRefSchema,
  coat: DomainRefSchema.nullable(),
  sex: PetSexSchema,
  birthDate: z.iso.date().nullable(),
  birthDatePrecision: BirthDatePrecisionSchema,
  ageMonths: z.number().int().nullable(),
  /** "≈ 2 anos" quando a idade é estimada. */
  ageLabel: z.string().nullable(),
  weightKg: z.number().nullable(),
  neutered: z.boolean().nullable(),
  microchipMasked: z.string().nullable(),
  color: z.string().nullable(),
  status: PetStatusSchema,
  deceasedAt: z.iso.date().nullable(),
  notes: z.string().nullable(),
  alerts: z.array(PetAlertSchema),
  tutors: z.array(PetTutorSchema),
  warnings: z.array(PetWarningSchema),
  lastAttendanceAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type PetResponse = z.infer<typeof PetResponseSchema>

export const ListPetsQuerySchema = z.object({
  q: z.string().max(120).optional(),
  tutorId: z.uuid().optional(),
  speciesId: z.uuid().optional(),
  status: PetStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListPetsQuery = z.output<typeof ListPetsQuerySchema>

export const PaginatedPetsSchema = z.object({
  data: z.array(PetResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
})
export type PaginatedPets = z.infer<typeof PaginatedPetsSchema>

/** Microchip completo, servido só a quem pode editar e sempre auditado. */
export const PetSensitiveSchema = z.object({
  microchip: z.string().nullable(),
})
export type PetSensitive = z.infer<typeof PetSensitiveSchema>

/**
 * Mascara o microchip como o CPF: os últimos dígitos bastam para conferir no balcão,
 * e o número inteiro é identificador rastreável do animal (PRD §4).
 */
export function maskMicrochip(microchip: string): string {
  const digits = microchip.replace(/\D/g, '')
  if (digits.length < 4) return '*'.repeat(digits.length)
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`
}

// ─── Pesagem (MOD-PET-07) ────────────────────────────────────────────────────

export const RecordWeightSchema = z.object({
  weightKg: z.number().min(0.05).max(120),
  measuredAt: z.iso.datetime().optional(),
})
export type RecordWeightInput = z.output<typeof RecordWeightSchema>

export const PetWeightSchema = z.object({
  id: z.uuid(),
  weightKg: z.number(),
  measuredAt: z.iso.datetime(),
})
export type PetWeightRecord = z.infer<typeof PetWeightSchema>

/** RN-11: variação relevante de peso vira alerta clínico. */
export const WEIGHT_VARIATION_ALERT_PERCENT = 15
