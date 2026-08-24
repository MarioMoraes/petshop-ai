import { AppError, type FieldError } from '@petshop/shared-types'
import { registerErrorHandler as registerKitErrorHandler, zodToFieldErrors } from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Catálogo de erro da identidade (PRD identidade_tenancy_01 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`; o que
 * fica aqui é o catálogo — quais códigos existem e que regra produz cada um.
 */

/** Converte o erro de validação do Zod no 422 padrão do catálogo. */
export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_IDENT_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Recurso não encontrado'): AppError {
  return new AppError('ERR_IDENT_001', detail)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_IDENT_003', detail)
}

export function conflict(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_IDENT_004', detail, fields)
}

export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, { logger, validationError, notFound })
}
