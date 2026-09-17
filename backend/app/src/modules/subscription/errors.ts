import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/** Catálogo de erro da assinatura (camada comercial, fatia 4). */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields: FieldError[] = zodToFieldErrors(error)
  return new AppError(
    'ERR_SUB_001',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function forbidden(
  detail = 'Só o administrador do estabelecimento cuida da assinatura',
): AppError {
  return new AppError('ERR_SUB_002', detail)
}

export function unauthorized(detail = 'Requisição não autenticada'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

export function invalidState(detail: string): AppError {
  return new AppError('ERR_SUB_003', detail)
}

export function notConfigured(): AppError {
  return new AppError(
    'ERR_SUB_004',
    'A cobrança ainda não está configurada nesta instalação. Fale com a equipe PetShop AI.',
  )
}

export function providerFailed(
  detail = 'Não foi possível falar com o provedor de pagamento. Tente de novo em instantes.',
): AppError {
  return new AppError('ERR_SUB_005', detail)
}
