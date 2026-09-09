import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro do MOD-SEC (PRD seguranca_compliance_13 §5).
 *
 * Três códigos, e o primeiro é o único que o host lança: `mfaRequired` é decidido em
 * `auth/session.ts`, antes do roteamento, porque precisa valer também para as rotas que
 * ainda são encaminhadas a outro processo. É a mesma inversão que `shared/errors.ts` já
 * faz ao importar `translateMultipartLimit` do MOD-PET.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields: FieldError[] = zodToFieldErrors(error)
  return new AppError(
    'ERR_SEC_002',
    detail ?? fields[0]?.message ?? 'Consulta inválida',
    fields,
  )
}

export function invalidQuery(detail: string): AppError {
  return new AppError('ERR_SEC_002', detail)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_SEC_003', detail)
}

/**
 * Requisição sem credencial. Usa o código de identidade de propósito: quem não se
 * autenticou não chegou a tocar em trilha nenhuma.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/** 423 — MOD-SEC-02. Lançado pelo host, com o catálogo do módulo. */
export function mfaRequired(): AppError {
  return new AppError(
    'ERR_SEC_001',
    'Ative a verificação em duas etapas para voltar a operar',
    undefined,
    { mfaEnrollmentRequired: true },
  )
}
