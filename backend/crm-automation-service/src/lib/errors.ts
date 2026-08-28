import { AppError, type FieldError } from '@petshop/shared-types'
import {
  registerErrorHandler as registerKitErrorHandler,
  zodToFieldErrors,
} from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Catálogo compartilhado com o messaging-service: os dois serviços são **um módulo**
 * (MOD-CRM) partido em dois processos, e um `ERR_CRM_006` precisa significar a mesma
 * coisa venha de onde vier.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_CRM_003',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Automação não encontrada'): AppError {
  return new AppError('ERR_CRM_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_CRM_003', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_CRM_012', detail)
}

export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/** §5: `config` que não bate com a união discriminada da chave. */
export function invalidAutomation(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_CRM_006', detail, fields)
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, { logger, validationError, notFound })
}
