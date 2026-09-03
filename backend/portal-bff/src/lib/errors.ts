import { AppError, type FieldError } from '@petshop/shared-types'
import {
  registerErrorHandler as registerKitErrorHandler,
  zodToFieldErrors,
} from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Catálogo de erro do Portal (PRD portal_tutor_09 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`; o que fica
 * aqui é o catálogo — quais códigos existem e que regra produz cada um.
 *
 * **A escolha que atravessa este arquivo é 404 no lugar de 403** (RN-03). Recurso que
 * existe para outro tutor responde "não encontrado", porque 403 confirma existência e
 * transformaria a superfície do cliente num enumerador da base do petshop. Vale para
 * todo `_own` do sistema, e não só para as rotas deste serviço.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_PORTAL_007',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

/** A resposta única para o que não é deste tutor — exista ou não (RN-03). */
export function notFound(detail = 'Não encontrado'): AppError {
  return new AppError('ERR_PORTAL_001', detail)
}

/** AC-03 de MOD-PORTAL-01: código errado, expirado ou de desafio já consumido. */
export function invalidCode(detail = 'Código inválido ou expirado'): AppError {
  return new AppError('ERR_PORTAL_002', detail)
}

/**
 * AC-04 de MOD-PORTAL-01: a ficha já tem dono.
 *
 * A mensagem **não diz para qual conta**. Dizer confirmaria a existência daquela conta a
 * quem está justamente tentando descobri-la.
 */
export function alreadyLinked(
  detail = 'Esta ficha já tem acesso ao Portal. Fale com o estabelecimento.',
): AppError {
  return new AppError('ERR_PORTAL_003', detail)
}

/** AC-01 de MOD-PORTAL-11 e AC-05 de MOD-PORTAL-01. */
export function tooManyAttempts(
  detail = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
): AppError {
  return new AppError('ERR_PORTAL_004', detail)
}

/**
 * AC-06 de MOD-PORTAL-01: o mesmo telefone em duas fichas.
 *
 * Marido e esposa no mesmo celular é caso comum, e o MOD-TUTOR permite quando a recepção
 * confirma que são pessoas diferentes. Escolher uma das duas por conta própria daria a
 * um deles o extrato financeiro do outro.
 */
export function ambiguousIdentifier(
  detail = 'Encontramos mais de um cadastro com este contato. Fale com o estabelecimento.',
): AppError {
  return new AppError('ERR_PORTAL_005', detail)
}

/** AC-05 de MOD-PORTAL-02: vínculo revogado, ou requisição sem a assinatura do gateway. */
export function unauthorized(detail = 'Seu acesso ao Portal não está mais ativo'): AppError {
  return new AppError('ERR_PORTAL_006', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_PORTAL_007', detail, fields)
}

/** RN-15: o Portal ou o agendamento online desligados neste estabelecimento. */
export function forbidden(detail: string): AppError {
  return new AppError('ERR_PORTAL_008', detail)
}

/** §6 dos módulos de domínio: operação que o estado atual não permite. */
export function invalidState(detail: string): AppError {
  return new AppError('ERR_PORTAL_009', detail)
}

/**
 * Serviço de domínio fora do ar.
 *
 * O BFF **não inventa resposta**: sem o scheduling não há disponibilidade, e mostrar
 * uma lista vazia diria ao tutor que o petshop não tem horário nenhum.
 */
export function upstreamUnavailable(
  detail = 'Não foi possível concluir agora. Tente novamente em instantes.',
): AppError {
  return new AppError('ERR_PORTAL_010', detail)
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, { logger, validationError, notFound })
}
