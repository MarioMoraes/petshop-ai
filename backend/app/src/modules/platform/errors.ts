import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro da plataforma (PRD observabilidade_admin_14 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`, e o handler
 * é **um só, do processo** (`shared/errors.ts`). O que fica aqui é o catálogo.
 *
 * **A escolha que atravessa este arquivo é 404 no lugar de 403** (RN-01), e é a mesma
 * decisão que o MOD-PORTAL tomou para o recurso alheio: um 403 confirmaria a quem está
 * varrendo que a superfície da plataforma existe. Quem não é da equipe não recebe a
 * informação de que há uma equipe.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_ADMIN_005',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

/** A resposta única para quem não é da plataforma — e para o que não existe (RN-01). */
export function notFound(detail = 'Não encontrado'): AppError {
  return new AppError('ERR_ADMIN_001', detail)
}

/** AC-03 de MOD-ADMIN-02: leitura de dado de tenant sem grant ativo. */
export function needsGrant(
  detail = 'Este acesso precisa da autorização do estabelecimento',
  extra?: Record<string, unknown>,
): AppError {
  return new AppError('ERR_ADMIN_002', detail, undefined, extra)
}

/**
 * AC-07 de MOD-ADMIN-02: escrita sob grant.
 *
 * O grant é de **leitura**, sempre. Suporte que precisa corrigir dado pede ao
 * estabelecimento que corrija — um terceiro escrevendo na ficha do cliente é
 * indefensável na primeira reclamação.
 */
export function readOnly(
  detail = 'O acesso de suporte é somente de leitura',
): AppError {
  return new AppError('ERR_ADMIN_003', detail)
}

/** AC-05 de MOD-ADMIN-01: a plataforma ficaria sem administrador. */
export function lastAdmin(
  detail = 'A plataforma ficaria sem administrador',
): AppError {
  return new AppError('ERR_ADMIN_004', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_ADMIN_005', detail, fields)
}

/** Grant em estado que não permite a transição pedida. */
export function invalidState(detail: string): AppError {
  return new AppError('ERR_ADMIN_006', detail)
}

export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_ADMIN_003', detail)
}
