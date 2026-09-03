import { z } from 'zod'
import {
  InvalidPhoneError,
  isValidCNPJ,
  isValidCPF,
  normalizePhoneBR,
  onlyDigits,
} from './br-documents.js'

/** PRD tutores_02 §5 — contratos de entrada e saída do tutor-service. */

// ─── Primitivos ──────────────────────────────────────────────────────────────

/**
 * Telefone já sai do schema em E.164. Quem consome o tipo nunca precisa lembrar de
 * normalizar — a normalização é parte do contrato, não uma etapa posterior.
 */
export const PhoneBRSchema = z.string().transform((value, ctx) => {
  try {
    return normalizePhoneBR(value)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof InvalidPhoneError ? error.message : 'Telefone inválido',
    })
    return z.NEVER
  }
})

export const CPFSchema = z
  .string()
  .transform(onlyDigits)
  .refine(isValidCPF, 'CPF inválido')

export const CNPJSchema = z
  .string()
  .transform(onlyDigits)
  .refine(isValidCNPJ, 'CNPJ inválido')

export const CEPSchema = z
  .string()
  .transform(onlyDigits)
  .refine((value) => /^\d{8}$/.test(value), 'CEP deve ter 8 dígitos')

export const UFSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine((value) => /^[A-Z]{2}$/.test(value), 'UF deve ter 2 letras')

// ─── Enums ───────────────────────────────────────────────────────────────────

export const PersonTypeSchema = z.enum(['PF', 'PJ'])
export type PersonType = z.infer<typeof PersonTypeSchema>

export const TutorStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'MERGED', 'ANONYMIZED'])
export type TutorStatus = z.infer<typeof TutorStatusSchema>

export const DataCompletenessSchema = z.enum(['COMPLETE', 'PARTIAL'])
export type DataCompleteness = z.infer<typeof DataCompletenessSchema>

export const ConsentChannelSchema = z.enum(['WHATSAPP', 'EMAIL', 'SMS', 'TERMS', 'IMAGE_USE'])
export type ConsentChannel = z.infer<typeof ConsentChannelSchema>

export const ConsentPurposeSchema = z.enum(['TRANSACTIONAL', 'MARKETING', 'BOTH'])
export type ConsentPurpose = z.infer<typeof ConsentPurposeSchema>

export const ConsentSourceSchema = z.enum(['STAFF_FORM', 'PORTAL', 'SITE', 'WHATSAPP', 'IMPORT'])
export type ConsentSource = z.infer<typeof ConsentSourceSchema>

/** Estado derivado do histórico append-only (PRD §6). */
export const ConsentStateSchema = z.enum([
  'NO_RECORD',
  'GRANTED',
  'REVOKED',
  'PENDING_RENEWAL',
])
export type ConsentState = z.infer<typeof ConsentStateSchema>

/**
 * Versão corrente dos termos. Subir esta constante coloca todo mundo que aceitou a
 * versão anterior em `PENDING_RENEWAL` (AC-04 de MOD-TUTOR-04).
 *
 * TODO(MOD-SEC): virar configuração por tenant quando o tenant puder publicar o
 * próprio termo de uso.
 */
export const CURRENT_TERMS_VERSION = '1.0'

/** Tags mantidas pelo sistema — nunca atribuídas à mão (AC-02 de MOD-TUTOR-05). */
export const SYSTEM_TAG_KEYS = ['INATIVO', 'INADIMPLENTE', 'ANIVERSARIANTE'] as const
export type SystemTagKey = (typeof SYSTEM_TAG_KEYS)[number]

export function isSystemTagKey(key: string): key is SystemTagKey {
  return (SYSTEM_TAG_KEYS as readonly string[]).includes(key)
}

// ─── Endereço ────────────────────────────────────────────────────────────────

export const AddressInputSchema = z.object({
  label: z.string().max(40).default('Casa'),
  zipCode: CEPSchema,
  street: z.string().min(3).max(160),
  number: z.string().max(20),
  complement: z.string().max(80).optional(),
  district: z.string().max(80),
  city: z.string().max(80),
  state: UFSchema,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accessNotes: z.string().max(300).optional(),
  isPrimary: z.boolean().default(false),
})
export type AddressInput = z.output<typeof AddressInputSchema>

export const UpdateAddressSchema = AddressInputSchema.partial()
export type UpdateAddressInput = z.output<typeof UpdateAddressSchema>

export const AddressResponseSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  zipCode: z.string(),
  street: z.string(),
  number: z.string(),
  complement: z.string().nullable(),
  district: z.string(),
  city: z.string(),
  state: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  accessNotes: z.string().nullable(),
  isPrimary: z.boolean(),
})
export type AddressResponse = z.infer<typeof AddressResponseSchema>

/** Resposta do lookup de CEP (MOD-TUTOR-03). */
export const CepLookupSchema = z.object({
  zipCode: z.string(),
  street: z.string(),
  district: z.string(),
  city: z.string(),
  state: z.string(),
})
export type CepLookup = z.infer<typeof CepLookupSchema>

// ─── Consentimento ───────────────────────────────────────────────────────────

export const ConsentsInputSchema = z.object({
  whatsapp: z.boolean(),
  email: z.boolean(),
  terms: z.boolean().refine((value) => value, 'Aceite dos termos é obrigatório'),
  imageUse: z.boolean().default(false),
})
export type ConsentsInput = z.output<typeof ConsentsInputSchema>

/** Uma transição de consentimento (PUT /v1/tutors/:id/consents). */
export const ConsentTransitionSchema = z.object({
  channel: ConsentChannelSchema,
  granted: z.boolean(),
  purpose: ConsentPurposeSchema.default('MARKETING'),
  source: ConsentSourceSchema.default('STAFF_FORM'),
  version: z.string().max(20).default(CURRENT_TERMS_VERSION),
})
export type ConsentTransitionInput = z.output<typeof ConsentTransitionSchema>

export const UpdateConsentsSchema = z.object({
  transitions: z.array(ConsentTransitionSchema).min(1).max(5),
})
export type UpdateConsentsInput = z.output<typeof UpdateConsentsSchema>

export const ConsentRecordSchema = z.object({
  id: z.uuid(),
  channel: ConsentChannelSchema,
  granted: z.boolean(),
  purpose: ConsentPurposeSchema,
  version: z.string(),
  source: ConsentSourceSchema,
  createdAt: z.iso.datetime(),
})
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>

export const ConsentStatusSchema = z.object({
  channel: ConsentChannelSchema,
  state: ConsentStateSchema,
  granted: z.boolean(),
  purpose: ConsentPurposeSchema.nullable(),
  version: z.string().nullable(),
  since: z.iso.datetime().nullable(),
})
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>

/** AC-03 de MOD-TUTOR-04: estado atual **e** o histórico inteiro, sem sobrescrita. */
export const ConsentsResponseSchema = z.object({
  current: z.array(ConsentStatusSchema),
  history: z.array(ConsentRecordSchema),
})
export type ConsentsResponse = z.infer<typeof ConsentsResponseSchema>

// ─── Tags ────────────────────────────────────────────────────────────────────

export const TagSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  color: z.string(),
  isSystem: z.boolean(),
})
export type Tag = z.infer<typeof TagSchema>

export const CreateTagSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(40)
    .transform((value) => value.trim().toUpperCase())
    .refine((value) => /^[A-Z0-9_]+$/.test(value), 'Use letras, números e underscore')
    .refine((value) => !isSystemTagKey(value), 'Esta chave é reservada para tags do sistema'),
  label: z.string().min(2).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato #RRGGBB')
    .default('#E34A32'),
})
export type CreateTagInput = z.output<typeof CreateTagSchema>

export const AssignTagSchema = z.object({
  tutorIds: z.array(z.uuid()).min(1).max(500),
})
export type AssignTagInput = z.output<typeof AssignTagSchema>

export const AssignTagResultSchema = z.object({
  assigned: z.number().int(),
  alreadyAssigned: z.number().int(),
})
export type AssignTagResult = z.infer<typeof AssignTagResultSchema>

// ─── Tutor ───────────────────────────────────────────────────────────────────

const TutorCoreSchema = z.object({
  personType: PersonTypeSchema.default('PF'),
  fullName: z.string().min(3).max(160),
  socialName: z.string().max(120).optional(),
  legalName: z.string().max(160).optional(),
  cpf: CPFSchema.optional(),
  cnpj: CNPJSchema.optional(),
  phone: PhoneBRSchema,
  phoneAlt: PhoneBRSchema.optional(),
  email: z.email('E-mail inválido').max(160).optional(),
  birthDate: z.iso.date().optional(),
  notes: z.string().max(2000).optional(),
})

/** AC-04 de MOD-TUTOR-01: PJ sem CNPJ ou sem razão social é 422, não um cadastro torto. */
function requirePjFields<T extends { personType: PersonType; cnpj?: string; legalName?: string }>(
  data: T,
  ctx: z.RefinementCtx,
): void {
  if (data.personType !== 'PJ') return
  if (!data.cnpj) {
    ctx.addIssue({
      code: 'custom',
      path: ['cnpj'],
      message: 'CNPJ e razão social são obrigatórios para pessoa jurídica',
    })
  }
  if (!data.legalName) {
    ctx.addIssue({
      code: 'custom',
      path: ['legalName'],
      message: 'CNPJ e razão social são obrigatórios para pessoa jurídica',
    })
  }
}

export const CreateTutorSchema = TutorCoreSchema.extend({
  address: AddressInputSchema.optional(),
  consents: ConsentsInputSchema,
  /** AC-02 de MOD-TUTOR-02: salvar por cima do alerta de duplicata provável. */
  duplicateAcknowledged: z.boolean().default(false),
}).superRefine(requirePjFields)
export type CreateTutorInput = z.output<typeof CreateTutorSchema>

/**
 * O PATCH aceita `null` para limpar campo opcional — distinguir "não mandei" de
 * "quero apagar" é a diferença entre um PATCH e um PUT disfarçado.
 */
export const UpdateTutorSchema = z
  .object({
    fullName: z.string().min(3).max(160),
    socialName: z.string().max(120).nullable(),
    legalName: z.string().max(160).nullable(),
    cpf: CPFSchema.nullable(),
    cnpj: CNPJSchema.nullable(),
    phone: PhoneBRSchema,
    phoneAlt: PhoneBRSchema.nullable(),
    email: z.email('E-mail inválido').max(160).nullable(),
    birthDate: z.iso.date().nullable(),
    notes: z.string().max(2000).nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    duplicateAcknowledged: z.boolean(),
  })
  .partial()
export type UpdateTutorInput = z.output<typeof UpdateTutorSchema>

export const TutorTagSummarySchema = z.object({
  key: z.string(),
  label: z.string(),
  color: z.string(),
  isSystem: z.boolean(),
})

export const TutorResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  personType: PersonTypeSchema,
  fullName: z.string(),
  /** RN-14: quando há nome social, é ele que aparece na tela. */
  displayName: z.string(),
  socialName: z.string().nullable(),
  legalName: z.string().nullable(),
  cpfMasked: z.string().nullable(),
  cnpjMasked: z.string().nullable(),
  phoneMasked: z.string(),
  phoneAltMasked: z.string().nullable(),
  email: z.email().nullable(),
  birthDate: z.iso.date().nullable(),
  notes: z.string().nullable(),
  status: TutorStatusSchema,
  dataCompleteness: DataCompletenessSchema,
  tags: z.array(TutorTagSummarySchema),
  petsCount: z.number().int(),
  balance: z.number(),
  lastAttendanceAt: z.iso.datetime().nullable(),
  mergedIntoId: z.uuid().nullable(),
  anonymizedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type TutorResponse = z.infer<typeof TutorResponseSchema>

/** Detalhe: acrescenta endereços e consentimentos ao corpo da listagem. */
export const TutorDetailSchema = TutorResponseSchema.extend({
  addresses: z.array(AddressResponseSchema),
  consents: z.array(ConsentStatusSchema),
})
export type TutorDetail = z.infer<typeof TutorDetailSchema>

/** Campos completos, servidos só a quem tem `tutor:read` e sempre auditados. */
export const TutorSensitiveSchema = z.object({
  cpf: z.string().nullable(),
  cnpj: z.string().nullable(),
  phone: z.string(),
  phoneAlt: z.string().nullable(),
  email: z.email().nullable(),
})
export type TutorSensitive = z.infer<typeof TutorSensitiveSchema>

export const ListTutorsQuerySchema = z.object({
  q: z.string().max(120).optional(),
  tag: z.string().max(40).optional(),
  status: TutorStatusSchema.optional(),
  hasDebt: z.stringbool().optional(),
  inactiveSince: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListTutorsQuery = z.output<typeof ListTutorsQuerySchema>

export const PaginatedTutorsSchema = z.object({
  data: z.array(TutorResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
})
export type PaginatedTutors = z.infer<typeof PaginatedTutorsSchema>

// ─── Deduplicação ────────────────────────────────────────────────────────────

export const CheckDuplicatesSchema = z.object({
  fullName: z.string().min(2).max(160).optional(),
  cpf: z.string().optional(),
  cnpj: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  /** Ignora este tutor nos candidatos — usado na edição. */
  excludeTutorId: z.uuid().optional(),
})
export type CheckDuplicatesInput = z.output<typeof CheckDuplicatesSchema>

export const DuplicateConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW'])
export type DuplicateConfidence = z.infer<typeof DuplicateConfidenceSchema>

export const DuplicateCandidateSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  phoneMasked: z.string(),
  cpfMasked: z.string().nullable(),
  status: TutorStatusSchema,
  confidence: DuplicateConfidenceSchema,
  /** `cpf`, `cnpj`, `phone`, `email` ou `name` — o que casou. */
  matchedOn: z.array(z.string()),
  similarity: z.number().min(0).max(1).nullable(),
})
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>

export const CheckDuplicatesResultSchema = z.object({
  candidates: z.array(DuplicateCandidateSchema),
  confidence: DuplicateConfidenceSchema.nullable(),
})
export type CheckDuplicatesResult = z.infer<typeof CheckDuplicatesResultSchema>

/** Limiar de similaridade `pg_trgm` do alerta de duplicata provável (AC-02). */
export const NAME_SIMILARITY_THRESHOLD = 0.6

// ─── Merge, anonimização e exportação ────────────────────────────────────────

export const MergeTutorSchema = z.object({
  sourceId: z.uuid(),
  /** Campo → de qual lado fica o valor. O padrão é o destino. */
  fieldResolution: z.record(z.string(), z.enum(['source', 'target'])).default({}),
  confirmation: z.literal('CONFIRMO_A_UNIFICACAO'),
})
export type MergeTutorInput = z.output<typeof MergeTutorSchema>

export const MergeResultSchema = z.object({
  targetId: z.uuid(),
  sourceId: z.uuid(),
  movedEntities: z.record(z.string(), z.array(z.string())),
})
export type MergeResult = z.infer<typeof MergeResultSchema>

/** RN-08: anonimização exige dupla confirmação e justificativa. */
export const AnonymizeTutorSchema = z.object({
  confirmation: z.literal('CONFIRMO_A_ANONIMIZACAO'),
  reason: z.string().min(10).max(500),
})
export type AnonymizeTutorInput = z.output<typeof AnonymizeTutorSchema>

/** Visão 360º (MOD-TUTOR-07). */
export const TutorOverviewSchema = z.object({
  tutor: TutorDetailSchema,
  pets: z.array(
    z.object({ id: z.uuid(), name: z.string(), species: z.string(), breed: z.string().nullable() }),
  ),
  appointments: z.array(
    z.object({
      id: z.uuid(),
      startsAt: z.iso.datetime(),
      serviceName: z.string(),
      status: z.string(),
    }),
  ),
  finance: z.object({
    balance: z.number(),
    lastEntryAt: z.iso.datetime().nullable(),
    openInvoices: z.number().int(),
  }),
  communications: z.array(
    z.object({ id: z.uuid(), channel: z.string(), direction: z.string(), sentAt: z.iso.datetime() }),
  ),
  /** Módulos ainda não implementados, para a UI não fingir que o dado é zero. */
  pendingModules: z.array(z.string()),
})
export type TutorOverview = z.infer<typeof TutorOverviewSchema>

/** Portabilidade LGPD (GET /v1/tutors/:id/export). */
export const TutorExportSchema = z.object({
  exportedAt: z.iso.datetime(),
  tutor: z.record(z.string(), z.unknown()),
  addresses: z.array(z.record(z.string(), z.unknown())),
  consents: z.array(ConsentRecordSchema),
  tags: z.array(TutorTagSummarySchema),
})
export type TutorExport = z.infer<typeof TutorExportSchema>

/**
 * O namespace do HMAC de `tutors.phone_hash`.
 *
 * Mora aqui, e não só no tutor-service, desde que o MOD-SITE passou a precisar dele:
 * o lead do site é marcado como "já é cliente" comparando o hash do telefone digitado
 * pelo visitante com o do tutor (AC-04 de MOD-SITE-08). Dois serviços calculando o
 * mesmo hash **precisam** partir da mesma string — um literal repetido que alguém
 * "melhorasse" de um lado faria a checagem parar de casar, em silêncio, e o petshop
 * trataria cliente antigo como aquisição nova para sempre.
 */
export const TUTOR_PHONE_HASH_NAMESPACE = 'tutor:phone'

/**
 * O namespace do HMAC de `tutors.email_hash`, pelo mesmo motivo do de telefone.
 *
 * Saiu de `backend/tutor-service/src/modules/tutors/crypto.ts` quando o MOD-PORTAL
 * passou a procurar a ficha pelo e-mail que o tutor digita na hora de vincular o
 * acesso. O valor entra no HMAC **já normalizado** por `normalizeEmail` — quem calcula
 * o hash de um lado e não do outro nunca casa, e a falha é silenciosa.
 */
export const TUTOR_EMAIL_HASH_NAMESPACE = 'tutor:email'
