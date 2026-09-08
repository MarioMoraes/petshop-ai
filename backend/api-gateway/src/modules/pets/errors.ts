import { AppError, type FieldError } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro do pet-service (PRD pets_03 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`; o que
 * fica aqui é o catálogo — quais códigos existem e que regra produz cada um — mais o
 * único erro que nasce fora do nosso código: o estouro de limite do multipart.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_PET_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Pet não encontrado'): AppError {
  return new AppError('ERR_PET_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_PET_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_PET_003', detail)
}

/**
 * Requisição que chegou sem a assinatura do gateway. Usa o código de identidade de
 * propósito: quem não se autenticou não chegou a tocar em nenhum pet.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/**
 * 409 de conflito. RN-15 e AC-02 de MOD-PET-02 mandam o corpo carregar o registro
 * existente: um microchip duplicado quase sempre é erro de digitação, e a UI precisa
 * poder abrir o cadastro que já existe em vez de só dizer "não".
 */
export function conflict(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_004', detail, undefined, extra)
}

/** AC-03 de MOD-PET-02 e AC-02 de MOD-PET-05: bloqueio por vínculo existente. */
export function blockedByLink(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_005', detail, undefined, extra)
}

/** AC-04 de MOD-PET-03: item de domínio em uso não pode ser excluído. */
export function domainInUse(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_006', detail, undefined, extra)
}

/**
 * AC-02 de MOD-PET-04: arquivo que não é imagem, é grande demais ou está corrompido.
 * A `cause` fica no log e nunca no corpo — mensagem de erro de biblioteca de imagem
 * não diz nada a quem está no balcão.
 */
export function invalidFile(detail: string, cause?: unknown): AppError {
  if (cause) logger.debug({ err: cause }, 'arquivo de imagem recusado')
  return new AppError('ERR_PET_007', detail)
}

/** AC-03 de MOD-PET-04: cota de fotos do plano atingida. */
export function quotaExceeded(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_008', detail, undefined, extra)
}

/**
 * AC-04 de MOD-PET-04: o storage falhou. 502 e não 500 — o defeito não é nosso, e a
 * distinção importa para quem lê o alerta às três da manhã.
 */
export function storageFailure(detail = 'Não conseguimos guardar a imagem agora. Tente de novo em instantes.'): AppError {
  return new AppError('ERR_PET_009', detail)
}

/** AC-05 de MOD-PET-04: uso de imagem sem o consentimento IMAGE_USE do tutor. */
export function consentMissing(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_010', detail, undefined, extra)
}

/**
 * O `@fastify/multipart` estoura com códigos próprios quando o arquivo passa do
 * limite. É entrada inválida (AC-02 de MOD-PET-04), não erro de servidor — e a
 * mensagem tem de ser a mesma do resto da validação de arquivo.
 */
const MULTIPART_LIMIT_CODES = new Set([
  'FST_REQ_FILE_TOO_LARGE',
  'FST_FILES_LIMIT',
  'FST_FIELDS_LIMIT',
  'FST_PARTS_LIMIT',
])

/**
 * O estouro de limite do `@fastify/multipart` chega com código próprio da biblioteca,
 * não como exceção nossa — daí o ramo. Exportado porque o handler de erro agora é do
 * host: sem registrá-lo lá, o arquivo de 40 MB voltaria a sair como 500 genérico em
 * vez do 422 do AC-02.
 */
export function translateMultipartLimit(error: unknown): AppError | null {
  const isLimit =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    MULTIPART_LIMIT_CODES.has((error as { code: string }).code)

  return isLimit
    ? invalidFile('Formato inválido. Envie JPG, PNG, WEBP ou HEIC de até 10 MB.')
    : null
}
