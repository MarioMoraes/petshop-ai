import { AppError, type FieldError } from '@petshop/shared-types'
import { registerErrorHandler as registerKitErrorHandler, zodToFieldErrors } from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Catálogo de erro do tutor-service (PRD tutores_02 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`; o que
 * fica aqui é o catálogo — quais códigos existem e que regra produz cada um.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_TUTOR_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Tutor não encontrado'): AppError {
  return new AppError('ERR_TUTOR_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_TUTOR_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_TUTOR_003', detail)
}

/**
 * Requisição que chegou sem a assinatura do gateway. Usa o código de identidade de
 * propósito: quem não se autenticou não chegou a tocar em nenhum tutor.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/** AC-01 de MOD-TUTOR-02: o 409 carrega o cadastro existente, para a UI oferecer abri-lo. */
export function duplicateConflict(detail: string, existingTutor: Record<string, unknown>): AppError {
  return new AppError('ERR_TUTOR_004', detail, undefined, { existingTutor })
}

/**
 * AC-02/AC-03: duplicata **provável**. Mesmo código, corpo diferente — aqui vai a
 * lista de candidatos, e o cliente reenvia com `duplicateAcknowledged` se for outra
 * pessoa. Não é um cadastro existente que se abre; é uma dúvida que se resolve.
 */
export function duplicateWarning(
  detail: string,
  extra: { candidates: unknown[]; confidence: string | null },
): AppError {
  return new AppError('ERR_TUTOR_004', detail, undefined, {
    ...extra,
    requiresAcknowledgement: true,
  })
}

export function blockedByHistory(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TUTOR_005', detail, undefined, extra)
}

export function terminalState(detail: string): AppError {
  return new AppError('ERR_TUTOR_006', detail)
}

export function invalidMerge(detail: string): AppError {
  return new AppError('ERR_TUTOR_007', detail)
}

export function cepUnavailable(detail = 'Não foi possível consultar o CEP. Preencha o endereço manualmente.'): AppError {
  return new AppError('ERR_TUTOR_008', detail)
}

export function blockedByConsent(detail: string): AppError {
  return new AppError('ERR_TUTOR_009', detail)
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, { logger, validationError, notFound })
}
