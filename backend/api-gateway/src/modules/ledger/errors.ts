import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro do financeiro (PRD financeiro_tutor_05 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`, e o
 * handler é **um só, do processo** (`shared/errors.ts`). O que fica aqui é o catálogo —
 * quais códigos existem e que regra produz cada um.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_LEDGER_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Registro financeiro não encontrado'): AppError {
  return new AppError('ERR_LEDGER_001', detail)
}

/** AC-04 de MOD-LEDGER-02: valor fora dos limites, ou data futura. */
export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_LEDGER_002', detail, fields)
}

/** AC-04 de MOD-LEDGER-03: o tenant desabilitou essa forma de pagamento. */
export function methodNotEnabled(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_LEDGER_003', detail, undefined, extra)
}

/** Lançamento já estornado, pagamento já revertido. Estornar duas vezes é criar dinheiro. */
export function alreadyReversed(detail: string): AppError {
  return new AppError('ERR_LEDGER_004', detail)
}

/** RN-01: alguém tentou editar o que é imutável. Espelha o `RAISE` do trigger. */
export function immutable(detail = 'Lançamento é imutável — use estorno por contrapartida'): AppError {
  return new AppError('ERR_LEDGER_005', detail)
}

/** Pacote expirado, suspenso ou sem créditos (AC-04 de MOD-LEDGER-07). */
export function packageUnavailable(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_LEDGER_007', detail, undefined, extra)
}

/** RN-10: o crédito cobre `service_id` listado, nunca por equivalência de valor. */
export function serviceNotCovered(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_LEDGER_008', detail, undefined, extra)
}

/** Alocação que excede o valor pago, ou aponta para débito já quitado. */
export function invalidAllocation(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_LEDGER_009', detail, undefined, extra)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_LEDGER_010', detail)
}

/**
 * RN-04: a chave de idempotência voltou com payload diferente.
 *
 * Não é o mesmo que repetir — repetir devolve o recurso original. Isto é um cliente
 * mandando duas operações **diferentes** sob a mesma chave, e adivinhar qual delas
 * vale seria pior do que recusar.
 */
export function idempotencyConflict(
  detail = 'Esta chave de idempotência já foi usada com outros dados',
): AppError {
  return new AppError('ERR_LEDGER_012', detail)
}

/**
 * Requisição que chegou sem sessão. Usa o código de identidade de propósito: quem não
 * se autenticou não chegou a tocar em nenhuma conta.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/**
 * O Gotenberg está fora, ou não existe neste ambiente.
 *
 * Vira 503 e não 500 porque não há nada errado com o pedido: o relatório continua
 * disponível em tela, e o PDF volta quando a infraestrutura voltar.
 */
export function documentUnavailable(
  detail = 'A geração de PDF está indisponível no momento. Tente novamente em instantes.',
): AppError {
  return new AppError('ERR_LEDGER_013', detail)
}
