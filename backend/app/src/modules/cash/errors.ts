import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/** Catálogo de erro do MOD-CAIXA (PRD caixa_17 §5). */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields: FieldError[] = zodToFieldErrors(error)
  return new AppError(
    'ERR_CASH_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_CASH_002', detail, fields)
}

export function notFound(detail = 'Caixa não encontrado'): AppError {
  return new AppError('ERR_CASH_001', detail)
}

export function forbidden(detail = 'Você não tem permissão para operar o caixa'): AppError {
  return new AppError('ERR_CASH_007', detail)
}

export function unauthorized(detail = 'Requisição não autenticada'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

export function alreadyOpen(): AppError {
  return new AppError(
    'ERR_CASH_003',
    'Já existe um caixa aberto. Feche o anterior antes de abrir outro.',
  )
}

export function noOpenSession(
  detail = 'Nenhum caixa aberto. Abra o caixa em Caixa do dia antes de continuar.',
): AppError {
  return new AppError('ERR_CASH_004', detail)
}

export function alreadyClosed(): AppError {
  return new AppError('ERR_CASH_005', 'Este caixa já foi fechado')
}

export function differenceWithoutNotes(differenceText: string): AppError {
  return new AppError(
    'ERR_CASH_006',
    `O contado não bate com o esperado (${differenceText}). Diga o que aconteceu antes de fechar.`,
    [{ field: 'notes', message: 'Explique a diferença' }],
  )
}

export function withdrawalAboveCash(availableText: string): AppError {
  return new AppError(
    'ERR_CASH_008',
    `A gaveta tem ${availableText} em dinheiro — a sangria não pode passar disso.`,
    [{ field: 'amountCents', message: `No máximo ${availableText}` }],
  )
}
