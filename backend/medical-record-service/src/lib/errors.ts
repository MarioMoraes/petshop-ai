import { AppError, type FieldError } from '@petshop/shared-types'
import { registerErrorHandler as registerKitErrorHandler, zodToFieldErrors } from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Catálogo de erro do prontuário (PRD prontuario_04 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`; o que
 * fica aqui é o catálogo — quais códigos existem e que regra produz cada um.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_PRONT_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Registro não encontrado'): AppError {
  return new AppError('ERR_PRONT_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_PRONT_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_PRONT_003', detail)
}

/**
 * Requisição que chegou sem a assinatura do gateway. Usa o código de identidade de
 * propósito: quem não se autenticou não chegou a tocar em nenhum prontuário.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/**
 * RN-03: alergia CRÍTICA bloqueando o serviço. O corpo carrega as alergias em
 * `blocking` — a tela precisa dizer **qual** substância, não apenas que existe
 * alguma. Um "serviço bloqueado" sem o motivo vira ligação para o veterinário.
 */
export function allergyConflict(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PRONT_005', detail, undefined, extra)
}

/**
 * RN-13: já existe atendimento vivo para este agendamento. O caminho normal para
 * chegar aqui é a reentrega do mesmo evento, e nesse caso o consumidor engole o
 * conflito; o 404 vira 409 quando alguém tenta lançar o registro à mão por cima.
 */
export function alreadyRegistered(
  detail = 'Este agendamento já possui atendimento registrado',
): AppError {
  return new AppError('ERR_PRONT_004', detail)
}

/**
 * RN-05: passadas as 24h, o registro não é reescrito — recebe adendo. O 409 carrega
 * a instrução porque a tela precisa oferecer o caminho certo no mesmo lugar em que
 * negou o errado.
 */
export function immutable(
  detail = 'Registros com mais de 24h não podem ser editados. Adicione um adendo.',
): AppError {
  return new AppError('ERR_PRONT_006', detail)
}

/**
 * RN-10 / RN-05 do MOD-DOC: prescrever exige registro no conselho.
 *
 * O código está no catálogo **desde o MOD-PRONT** e nenhuma rota conseguia levantá-lo,
 * porque `professionals` não tinha onde guardar o CRMV. A fatia 2 do MOD-DOC dá a
 * coluna, e é aqui que a regra passa a existir de verdade.
 *
 * É 403 e não 422 de propósito: não falta um campo no formulário — falta autoridade
 * para assinar o documento.
 */
export function crmvRequired(
  detail = 'Prescrição exige CRMV cadastrado no perfil do profissional',
): AppError {
  return new AppError('ERR_PRONT_009', detail)
}

/**
 * Falta dado do estabelecimento para emitir documento formal (AC-02 de MOD-DOC-01).
 *
 * Documento com valor legal sem o endereço de quem emitiu não é documento; é papel
 * timbrado pela metade. O corpo diz **qual** dado falta, porque quem vê a mensagem é
 * quem pode preenchê-lo — e "dados insuficientes" sozinho vira chamado de suporte.
 */
export function documentDataMissing(detail: string): AppError {
  return new AppError('ERR_DOC_002', detail)
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, { logger, validationError, notFound })
}
