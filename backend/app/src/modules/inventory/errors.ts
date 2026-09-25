import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/** Catálogo de erro do MOD-ESTOQUE (PRD estoque_16 §5). */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields: FieldError[] = zodToFieldErrors(error)
  return new AppError(
    'ERR_INV_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_INV_002', detail, fields)
}

export function notFound(detail = 'Produto não encontrado'): AppError {
  return new AppError('ERR_INV_001', detail)
}

export function forbidden(detail = 'Você não tem permissão para mexer no estoque'): AppError {
  return new AppError('ERR_INV_009', detail)
}

export function unauthorized(detail = 'Requisição não autenticada'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

export function expiryRequired(): AppError {
  return new AppError('ERR_INV_003', 'Este produto controla validade — informe a data do lote', [
    { field: 'expiresAt', message: 'Informe a validade do lote' },
  ])
}

export function productHasHistory(): AppError {
  return new AppError(
    'ERR_INV_004',
    'Este produto já teve movimento e não pode ser excluído. Desative-o: ele sai dos seletores e o histórico fica.',
  )
}

export function lotExpiryMismatch(batchCode: string, expiresAt: string | null): AppError {
  return new AppError(
    'ERR_INV_005',
    expiresAt
      ? `O lote ${batchCode} já está cadastrado com validade ${expiresAt.split('-').reverse().join('/')}. Confira a data.`
      : `O lote ${batchCode} já está cadastrado sem validade. Confira o código do lote.`,
    [{ field: 'expiresAt', message: 'Validade diferente da já cadastrada para este lote' }],
  )
}

export function productInactive(): AppError {
  return new AppError('ERR_INV_007', 'Este produto está desativado. Reative-o antes de movimentar.')
}

export function idempotencyConflict(): AppError {
  return new AppError(
    'ERR_INV_013',
    'Esta operação já foi registrada com outros dados. Recarregue a tela e tente de novo.',
  )
}
