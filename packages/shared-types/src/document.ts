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
