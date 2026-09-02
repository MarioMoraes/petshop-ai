import { AppError, type FieldError } from '@petshop/shared-types'
import {
  registerErrorHandler as registerKitErrorHandler,
  zodToFieldErrors,
} from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Catálogo de erro do relacionamento (PRD relacionamento_crm_08 §5).
 *
 * Um código a menos do que parece: **falta de consentimento não é erro**. O chamador
 * pediu certo, e a resposta correta é uma mensagem `BLOCKED` com o motivo — devolver
 * 4xx faria cada consumidor de evento ter de distinguir "eu errei" de "o tutor não
 * quer", e a tentação seria tratar as duas como falha e reprocessar.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_CRM_003',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Mensagem não encontrada'): AppError {
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

/** AC-01 de MOD-CRM-03: o template pedido não existe, nem no código nem no tenant. */
export function unknownTemplate(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_CRM_002', detail, undefined, extra)
}

/** AC-04 de MOD-CRM-02: template de sistema não se apaga — desative a automação. */
export function systemTemplate(
  detail = 'Este texto é de sistema: desative a automação que o usa em vez de excluí-lo',
): AppError {
  return new AppError('ERR_CRM_004', detail)
}

/** AC-04 de MOD-CRM-07 e §5: automação com `config` inválida para a própria chave. */
export function invalidAutomation(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_CRM_006', detail, fields)
}

/** §6: transição que a máquina de estado não permite (cancelar o que já saiu). */
export function invalidTransition(detail: string): AppError {
  return new AppError('ERR_CRM_007', detail)
}

/** RN-05: teto por minuto ou diário. `extra.retryAfter` diz em quanto tempo tentar. */
export function rateLimited(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_CRM_008', detail, undefined, extra)
}

/**
 * RN-13: módulo desligado. Recusa em vez de enfileirar — uma fila que cresce
 * esperando alguém religar o motor é pior que a recusa, porque no dia em que ligarem
 * ela dispara meses de mensagem de uma vez.
 */
export function messagingDisabled(
  detail = 'As mensagens automáticas estão desligadas nas configurações deste estabelecimento',
): AppError {
  return new AppError('ERR_CRM_013', detail)
}

/** RN-11: webhook com token ou assinatura que não confere. */
export function badWebhook(detail = 'Assinatura inválida'): AppError {
  return new AppError('ERR_CRM_014', detail)
}

/**
 * MOD-CRM-01: a Evolution não respondeu, ou respondeu recusando.
 *
 * 502 e não 500: o problema não é deste serviço, e a diferença importa para quem lê o
 * log de produção às três da manhã. O detalhe do provedor viaja junto — "não foi
 * possível conectar" sem a frase original não diz a ninguém onde olhar.
 */
export function providerUnavailable(detail: string): AppError {
  return new AppError('ERR_CRM_015', detail)
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, { logger, validationError, notFound })
}
