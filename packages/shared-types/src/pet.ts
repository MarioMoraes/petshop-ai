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
  /** RN-16: cinco "Mel" no mesmo tenant é normal — a foto é o que desambigua. */
  coverPhotoUrl: z.string().nullable(),
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
  /** Pesagem imediatamente anterior na série; `null` na primeira. */
  previousWeightKg: z.number().nullable(),
  /** Variação percentual sobre a anterior, positiva no ganho. */
  variationPercent: z.number().nullable(),
  /** RN-11: variação acima do limite dentro da janela clínica. */
  alert: z.boolean(),
})
export type PetWeightRecord = z.infer<typeof PetWeightSchema>

/** RN-11: variação relevante de peso vira alerta clínico. */
export const WEIGHT_VARIATION_ALERT_PERCENT = 15

/** A janela de RN-11: perder 15% em dois meses é clínico; em dois anos, é a vida. */
export const WEIGHT_VARIATION_WINDOW_DAYS = 60

/**
 * RN-11 aplicada a um par de pesagens. Fora da janela de 60 dias a variação continua
 * sendo calculada e exibida — só não vira alerta.
 */
export function weightVariation(
  current: { weightKg: number; measuredAt: Date },
  previous: { weightKg: number; measuredAt: Date } | null,
): { previousWeightKg: number | null; variationPercent: number | null; alert: boolean } {
  if (!previous || previous.weightKg <= 0) {
    return { previousWeightKg: null, variationPercent: null, alert: false }
  }

  const variationPercent =
    Math.round(((current.weightKg - previous.weightKg) / previous.weightKg) * 1000) / 10
  const elapsedDays =
    (current.measuredAt.getTime() - previous.measuredAt.getTime()) / 86_400_000

  return {
    previousWeightKg: previous.weightKg,
    variationPercent,
    alert:
      Math.abs(variationPercent) > WEIGHT_VARIATION_ALERT_PERCENT &&
      elapsedDays <= WEIGHT_VARIATION_WINDOW_DAYS,
  }
}

// ─── Catálogo do tenant (MOD-PET-03) ─────────────────────────────────────────

export const CreateBreedSchema = z.object({
  speciesId: z.uuid(),
  label: z.string().min(2).max(80),
  defaultSizeId: z.uuid().optional(),
  groomingNotes: z.string().max(2000).optional(),
})
export type CreateBreedInput = z.output<typeof CreateBreedSchema>

export const UpdateBreedSchema = z
  .object({
    label: z.string().min(2).max(80),
    defaultSizeId: z.uuid().nullable(),
    groomingNotes: z.string().max(2000).nullable(),
  })
  .partial()
export type UpdateBreedInput = z.output<typeof UpdateBreedSchema>

/**
 * AC-02/AC-04: "sumir do seletor" é uma intenção só, com dois mecanismos por baixo —
 * a raça global vira uma linha em `breed_visibility`, a raça do tenant tem `active`
 * desligado. A tela não deveria precisar saber a diferença.
 */
export const BreedVisibilitySchema = z.object({ hidden: z.boolean() })
export type BreedVisibilityInput = z.output<typeof BreedVisibilitySchema>

/** A raça como a tela de administração do catálogo precisa vê-la. */
export const ManagedBreedSchema = BreedSchema.extend({
  hidden: z.boolean(),
  /** AC-04: o número que a confirmação de desativação mostra. */
  petsCount: z.number().int(),
})
export type ManagedBreed = z.infer<typeof ManagedBreedSchema>

// ─── Transferência de titularidade (MOD-PET-05) ──────────────────────────────

/**
 * A confirmação literal é do §5 do PRD, e não é cerimônia: a transferência encerra
 * todos os vínculos ativos de uma vez e não tem desfazer — só uma nova transferência
 * de volta, que já entra no histórico como outro evento.
 */
export const TransferPetSchema = z.object({
  toTutorId: z.uuid(),
  reason: TransferReasonSchema,
  notes: z.string().max(500).optional(),
  effectiveDate: z.iso.date().optional(),
  confirmation: z.literal('CONFIRMO_A_TRANSFERENCIA'),
})
export type TransferPetInput = z.output<typeof TransferPetSchema>

export const TRANSFER_CONFIRMATION = 'CONFIRMO_A_TRANSFERENCIA'

export const TRANSFER_REASON_LABELS: Record<TransferReason, string> = {
  ADOPTION: 'Adoção',
  SALE: 'Venda',
  TUTOR_DEATH: 'Falecimento do tutor',
  CORRECTION: 'Correção de cadastro',
  OTHER: 'Outro',
}

export const PetTransferSchema = z.object({
  id: z.uuid(),
  fromTutorId: z.uuid().nullable(),
  fromTutorName: z.string().nullable(),
  toTutorId: z.uuid(),
  toTutorName: z.string(),
  reason: TransferReasonSchema,
  notes: z.string().nullable(),
  effectiveDate: z.iso.date().nullable(),
  createdAt: z.iso.datetime(),
})
export type PetTransfer = z.infer<typeof PetTransferSchema>

// ─── Óbito (MOD-PET-08) ──────────────────────────────────────────────────────

export const RegisterDeathSchema = z.object({
  deceasedAt: z.iso.date(),
  notes: z.string().max(500).optional(),
})
export type RegisterDeathInput = z.output<typeof RegisterDeathSchema>

/**
 * AC-03: a reversão exige justificativa. Ela vai para a auditoria, não para o
 * cadastro — quem confere depois precisa saber por que um óbito registrado deixou
 * de existir.
 */
export const RevertDeathSchema = z.object({
  justification: z.string().min(10).max(500),
})
export type RevertDeathInput = z.output<typeof RevertDeathSchema>

/** AC-03: depois disso, só o suporte reverte. */
export const DEATH_REVERSAL_WINDOW_DAYS = 30

// ─── Álbum de fotos (MOD-PET-04) ─────────────────────────────────────────────

/**
 * Limites do AC-02. Estão aqui, e não só no serviço, porque a tela precisa recusar o
 * arquivo de 40 MB antes de subir 40 MB para ouvir "não".
 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
export const MAX_PHOTOS_PER_UPLOAD = 10

export const ACCEPTED_PHOTO_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const
export type AcceptedPhotoMime = (typeof ACCEPTED_PHOTO_MIMES)[number]

/** RN-13: nenhuma imagem de pet é publicamente enumerável. */
export const PHOTO_URL_TTL_SECONDS = 900

export const PhotoSourceSchema = z.enum(['STAFF', 'TUTOR', 'GROOMING_RESULT'])
export type PhotoSource = z.infer<typeof PhotoSourceSchema>

export const PHOTO_VARIANTS = ['thumb', 'medium', 'full'] as const
export type PhotoVariant = (typeof PHOTO_VARIANTS)[number]

/**
 * Largura de cada variante. `full` não é o original: o arquivo é sempre reprocessado,
 * e é o reprocessamento que garante o RN-12 — o EXIF, com o GPS da casa do tutor, não
 * sobrevive à reencodificação.
 */
export const PHOTO_VARIANT_WIDTHS: Record<PhotoVariant, number> = {
  thumb: 240,
  medium: 800,
  full: 1600,
}

export const PhotoUrlsSchema = z.object({
  thumb: z.string(),
  medium: z.string(),
  full: z.string(),
})
export type PhotoUrls = z.infer<typeof PhotoUrlsSchema>

export const PetPhotoSchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  /** URLs assinadas, válidas por 15 minutos. Não guarde: elas vencem. */
  urls: PhotoUrlsSchema,
  caption: z.string().nullable(),
  takenAt: z.iso.datetime(),
  source: PhotoSourceSchema,
  attendanceId: z.uuid().nullable(),
  /** MOD-PRONT-10: `BEFORE`/`AFTER` no atendimento; nulo é foto de álbum. */
  attendancePhase: z.enum(['BEFORE', 'AFTER']).nullable(),
  marketingUse: z.boolean(),
  isCover: z.boolean(),
  sizeBytes: z.number().int(),
  mimeType: z.string(),
  createdAt: z.iso.datetime(),
})
export type PetPhoto = z.infer<typeof PetPhotoSchema>

/** Metadados que acompanham o upload, no mesmo multipart dos arquivos. */
export const UploadPhotoMetaSchema = z.object({
  caption: z.string().max(140).optional(),
  source: PhotoSourceSchema.default('STAFF'),
  takenAt: z.iso.datetime().optional(),
  attendanceId: z.uuid().optional(),
  /**
   * MOD-PRONT-10 — a foto de antes e depois. Só faz sentido com `attendanceId`:
   * "antes" de nada não quer dizer nada, e é o que o `.refine` abaixo garante.
   */
  attendancePhase: z.enum(['BEFORE', 'AFTER']).optional(),
}).refine((meta) => !meta.attendancePhase || !!meta.attendanceId, {
  message: 'A fase antes/depois exige o atendimento correspondente',
  path: ['attendancePhase'],
})
export type UploadPhotoMeta = z.output<typeof UploadPhotoMetaSchema>

export const UpdatePhotoSchema = z
  .object({
    caption: z.string().max(140).nullable(),
    /** Define esta foto como capa do pet; `false` remove a capa. */
    isCover: z.boolean(),
    /** RN-14: exige o consentimento IMAGE_USE do tutor no momento da marcação. */
    marketingUse: z.boolean(),
  })
  .partial()
export type UpdatePhotoInput = z.output<typeof UpdatePhotoSchema>

/** O que a tela mostra sobre o consumo do plano (AC-03). */
export const PhotoQuotaSchema = z.object({
  used: z.number().int(),
  limit: z.number().int().nullable(),
})
export type PhotoQuota = z.infer<typeof PhotoQuotaSchema>

export const PetAlbumSchema = z.object({
  photos: z.array(PetPhotoSchema),
  quota: PhotoQuotaSchema,
})
export type PetAlbum = z.infer<typeof PetAlbumSchema>

/**
 * Assinatura de arquivo por magic bytes (AC-02).
 *
 * A extensão e o `content-type` do multipart são declarações do cliente: um `.pdf`
 * renomeado para `.jpg` chega dizendo `image/jpeg`. O que decide é o começo do
 * arquivo — e é por isso que a validação não pode viver no browser.
 */
export function sniffImageMime(bytes: Uint8Array): AcceptedPhotoMime | null {
  if (bytes.length < 12) return null

  const startsWith = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte)

  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'

  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length))

  // RIFF....WEBP
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'

  // ISO-BMFF: o box `ftyp` traz a marca. O iPhone entrega HEIC por padrão, e recusá-lo
  // faria a recepção converter foto à mão no meio do atendimento.
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4)
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm'].includes(brand)) return 'image/heic'
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif'
  }

  return null
}
