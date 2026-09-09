import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro da agenda (PRD agenda_operacao_06 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`, e o
 * handler é **um só, do processo** (`shared/errors.ts`). O que fica aqui é o catálogo —
 * quais códigos existem e que regra produz cada um.
 *
 * Vale para os dois módulos da fatia: `modules/scheduling` e `modules/schedule-catalog`
 * respondem pelo mesmo catálogo, porque são as duas metades do mesmo PRD.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_AGENDA_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Registro não encontrado'): AppError {
  return new AppError('ERR_AGENDA_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_AGENDA_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_AGENDA_003', detail)
}

/**
 * Requisição que chegou sem sessão. Usa o código de identidade de propósito: quem não
 * se autenticou não chegou a tocar em nenhuma agenda.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/**
 * AC-03 de MOD-AGENDA-01: serviço com agendamento futuro não é excluído. O corpo
 * carrega a contagem — "não dá" sem dizer quantos é o tipo de resposta que faz o
 * admin abrir um chamado.
 */
export function serviceInUse(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_AGENDA_011', detail, undefined, extra)
}

/**
 * AC-04 de MOD-AGENDA-02 e AC-02 de MOD-AGENDA-03: a operação esbarra em
 * agendamentos futuros e exige reatribuição ou cancelamento em lote. O corpo lista
 * os afetados, porque a decisão é de quem está na tela.
 */
export function futureAppointmentsBlock(
  detail: string,
  extra?: Record<string, unknown>,
): AppError {
  return new AppError('ERR_AGENDA_012', detail, undefined, extra)
}

/** RN-05: profissional fora da jornada, não habilitado ou bloqueado. */
export function professionalUnavailable(
  detail: string,
  extra?: Record<string, unknown>,
): AppError {
  return new AppError('ERR_AGENDA_005', detail, undefined, extra)
}
