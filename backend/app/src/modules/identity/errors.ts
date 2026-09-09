import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro da identidade (PRD identidade_tenancy_01 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`, e o
 * handler é **um só, do processo** (`shared/errors.ts`). O que fica aqui é o catálogo —
 * quais códigos existem e que regra produz cada um.
 *
 * Os quatro primeiros repetem, por valor, o que o host usa como rede de segurança:
 * `ERR_IDENT_001`, `002`, `003` e `005` são a identidade falando por si e também o
 * genérico de quem não tem catálogo. Os quatro últimos são só deste módulo.
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

/**
 * 410 — o recurso existiu e não vale mais. É o convite vencido ou revogado (AC-03 de
 * MOD-IDENT-06), e a distinção em relação ao 404 é útil para quem recebe: "o link
 * expirou" pede um convite novo; "não existe" faria a pessoa procurar erro de digitação.
 */
export function gone(detail: string): AppError {
  return new AppError('ERR_IDENT_006', detail)
}

/** 402 — RN-11, limite de usuários do plano. */
export function planLimitReached(detail: string): AppError {
  return new AppError('ERR_IDENT_007', detail)
}

/**
 * 423 — RN-04, tenant suspenso ou encerrado.
 *
 * O gateway já barra escrita de tenant bloqueado, mas o aceite de convite chega sem
 * contexto de tenant nenhum — o convidado ainda não é membro. Quem descobre o estado
 * do estabelecimento é o módulo, e é aqui que ele recusa.
 */
export function tenantBlocked(detail: string): AppError {
  return new AppError('ERR_IDENT_008', detail)
}
