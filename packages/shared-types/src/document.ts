import { z } from 'zod'

/**
 * Documentos formais (PRD documentos_pdf_11 §4).
 *
 * O que entra em `documents` é **o que tem valor legal**: precisa bater, byte a byte,
 * com o papel que a pessoa levou naquele dia. Extrato e relatório ficam de fora de
 * propósito — descrevem o estado atual, e um extrato guardado é um extrato errado uma
 * semana depois (RN-01).
 */

export const DocumentKindSchema = z.enum([
  'RECEIPT',
  'PRESCRIPTION',
  'TERM_ACCEPTANCE',
  'IMAGE_CONSENT',
])
export type DocumentKind = z.infer<typeof DocumentKindSchema>

export const DocumentStatusSchema = z.enum(['PENDING', 'ISSUED', 'FAILED', 'CANCELLED'])
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  RECEIPT: 'Recibo',
  PRESCRIPTION: 'Receituário',
  TERM_ACCEPTANCE: 'Termo de responsabilidade',
  IMAGE_CONSENT: 'Autorização de uso de imagem',
}

/**
 * O prefixo da série, por tipo.
 *
 * `RECEIPT` é string vazia porque a série do recibo **já existe em produção** no formato
 * `2026/000123`, desde o MOD-LEDGER. Renumerar documento emitido é reescrever papel
 * entregue, e é isso que o AC-04 de MOD-DOC-03 proíbe.
 */
export const DOCUMENT_NUMBER_PREFIXES: Record<DocumentKind, string> = {
  RECEIPT: '',
  PRESCRIPTION: 'RX',
  TERM_ACCEPTANCE: 'TR',
  IMAGE_CONSENT: 'IM',
}

/** `2026/000123` para recibo, `RX-2026/000004` para o resto. */
export function formatDocumentNumber(kind: DocumentKind, year: number, sequential: number): string {
  const prefix = DOCUMENT_NUMBER_PREFIXES[kind]
  const serie = `${year}/${String(sequential).padStart(6, '0')}`
  return prefix ? `${prefix}-${serie}` : serie
}

/**
 * Guarda contábil e clínica: cinco anos a partir da emissão (RN-17).
 *
 * Vale inclusive contra o pedido de exclusão do art. 18 que o MOD-PORTAL-09 entregou —
 * ele anonimiza o cadastro e **não** apaga documento emitido.
 */
export const DOCUMENT_RETENTION_YEARS = 5

export function documentRetentionUntil(issuedAt: Date): Date {
  const until = new Date(issuedAt)
  until.setUTCFullYear(until.getUTCFullYear() + DOCUMENT_RETENTION_YEARS)
  return until
}

/**
 * Validade da URL assinada de um documento arquivado.
 *
 * Quinze minutos, o mesmo que o recibo já usava desde o MOD-LEDGER: o documento é
 * aberto na hora, do balcão ou do e-mail. Um endereço que vale um dia é um endereço que
 * circula em grupo de WhatsApp.
 */
export const DOCUMENT_URL_TTL_SECONDS = 900

/**
 * Tetos de reprocesso (MOD-DOC-11).
 *
 * Na décima falha o documento vai a `FAILED`, sai da fila e vira pendência visível —
 * falha silenciosa em documento com valor legal é a pior categoria de falha silenciosa.
 */
export const DOCUMENT_MAX_ATTEMPTS = 10

export const DocumentViewSchema = z.object({
  id: z.string().uuid(),
  kind: DocumentKindSchema,
  number: z.string(),
  status: DocumentStatusSchema,
  tutorId: z.string().uuid().nullable(),
  petId: z.string().uuid().nullable(),
  issuedAt: z.string().datetime().nullable(),
  /** Nula enquanto o arquivo não existir — a tela mostra "em preparo", não link morto. */
  url: z.string().nullable(),
})
export type DocumentView = z.infer<typeof DocumentViewSchema>

// ─── MOD-DOC-04 — receituário veterinário ────────────────────────────────────

/**
 * Um item da prescrição.
 *
 * Estruturado, e não campo livre, porque é o único jeito de o papel sair legível e de
 * o sistema poder responder "que medicamentos este pet já tomou". Os campos são os
 * quatro que o receituário brasileiro exige: o que dar, quanto, de quanto em quanto
 * tempo e por quantos dias.
 */
export const PrescriptionItemSchema = z.strictObject({
  drug: z.string().trim().min(2).max(120),
  concentration: z.string().trim().max(60).optional(),
  dosage: z.string().trim().min(1).max(120),
  frequency: z.string().trim().min(1).max(120),
  durationDays: z.number().int().min(1).max(365),
})
export type PrescriptionItem = z.infer<typeof PrescriptionItemSchema>

/**
 * `z.strictObject`, não `z.object` — em todo schema deste módulo.
 *
 * O `z.object` descarta chave desconhecida em silêncio, e numa prescrição isso é um
 * campo clínico que a tela mandou, o servidor ignorou e ninguém viu faltar.
 */
export const CreatePrescriptionSchema = z.strictObject({
  items: z.array(PrescriptionItemSchema).min(1).max(20),
  /** Orientações ao tutor. Cifradas, como todo campo livre clínico. */
  instructions: z.string().trim().max(2000).optional(),
})
export type CreatePrescriptionInput = z.output<typeof CreatePrescriptionSchema>

/** Anular exige motivo: anulação sem motivo é exclusão disfarçada (RN-03). */
export const VoidPrescriptionSchema = z.strictObject({
  reason: z.string().trim().min(5).max(500),
})
export type VoidPrescriptionInput = z.output<typeof VoidPrescriptionSchema>

/**
 * Os tipos de atendimento em que cabe um receituário.
 *
 * Banho e tosa ficam de fora: prescrição pendurada num banho não é erro de digitação,
 * é registro clínico no lugar errado — e o receituário é documento com valor legal.
 */
export const PRESCRIBABLE_ATTENDANCE_TYPES = ['VET_CONSULT', 'VACCINE', 'PROCEDURE'] as const

export const PrescriptionViewSchema = z.object({
  id: z.string().uuid(),
  attendanceId: z.string().uuid(),
  petId: z.string().uuid(),
  /** Série do documento: `RX-2026/000004`. */
  number: z.string(),
  /** Snapshot do registro no dia — `12345/SP` (AC-03 de MOD-DOC-05). */
  crmv: z.string(),
  vetId: z.string().uuid(),
  vetName: z.string(),
  items: z.array(PrescriptionItemSchema),
  instructions: z.string().nullable(),
  issuedAt: z.string().datetime(),
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string().nullable(),
  /** Estado do arquivo, não da prescrição: o PDF pode estar a caminho. */
  documentStatus: DocumentStatusSchema,
  /**
   * URL assinada de 15 minutos, ou nula enquanto o arquivo não existir.
   *
   * Só o **detalhe** a emite, e emiti-la é o que a trilha de auditoria registra como
   * download (§9): a listagem mostra número e data, e isso não é acessar o documento.
   */
  url: z.string().nullable(),
})
export type PrescriptionView = z.infer<typeof PrescriptionViewSchema>

export const PRESCRIPTION_TITLE = 'Receituário veterinário'

/**
 * O registro do prescritor, como sai impresso: `12345/SP`.
 *
 * Duas colunas no cadastro (`crmv` e `crmv_state`) e **uma** no receituário, porque o
 * que a prescrição guarda é o snapshot do dia — e o que se confere num papel é o
 * registro inteiro, não o número solto.
 */
export function formatCrmv(number: string, state: string): string {
  return `${number}/${state}`
}
