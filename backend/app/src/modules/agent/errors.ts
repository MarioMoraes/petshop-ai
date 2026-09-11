import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro do MOD-AI (PRD agentes_ia_15 §5).
 *
 * **Nenhum deles alcança o cliente no WhatsApp**, e isso não é detalhe de implementação:
 * é a RN-09. A superfície que pode responder 4xx é a da equipe, no Admin; do lado do
 * canal, toda falha vira conversa na fila da recepção, porque um cliente que recebe
 * "ERR_AI_006" do petshop teve uma experiência pior do que o silêncio.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_AI_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Conversa não encontrada'): AppError {
  return new AppError('ERR_AI_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_AI_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_AI_003', detail)
}

export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/** §6: assumir a que já é de outra pessoa, responder a que já foi encerrada. */
export function invalidTransition(detail: string): AppError {
  return new AppError('ERR_AI_004', detail)
}

/**
 * MOD-AI-06 / RN-09 — o provedor do modelo não respondeu.
 *
 * 503, e **nunca chega ao tutor**: quem o vê é a tela da equipe. Do lado do WhatsApp a
 * falha do provedor vira conversa na fila da recepção, porque um cliente que recebe um
 * código de erro do petshop teve uma experiência pior que o silêncio.
 */
export function providerUnavailable(detail: string): AppError {
  return new AppError('ERR_AI_006', detail)
}
