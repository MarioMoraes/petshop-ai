import { AppError, toProblemDetails, type FieldError } from '@petshop/shared-types'
import { TenantContextMissingError } from '@petshop/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Tradução de erro para `application/problem+json` (PRD prontuario_04 §5).
 *
 * Um handler único garante que nenhuma rota invente formato próprio e que detalhe
 * interno — SQL, host, PII — nunca escape para o cliente.
 */

const PROBLEM_CONTENT_TYPE = 'application/problem+json'

function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(raiz)',
    message: issue.message,
  }))
}

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

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.id

    if (error instanceof AppError) {
      // Erro de negócio esperado: log em nível baixo, sem stack.
      logger.info(
        { traceId, code: error.code, status: error.status, path: request.url },
        error.message,
      )
      return reply
        .status(error.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(toProblemDetails(error, traceId))
    }

    if (error instanceof ZodError) {
      const appError = validationError(error)
      return reply
        .status(appError.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(toProblemDetails(appError, traceId))
    }

    if (error instanceof TenantContextMissingError) {
      // Bug de programação: alguém tocou tabela com RLS fora de withTenant().
      logger.error({ traceId, code: 'TENANT_CONTEXT_MISSING', path: request.url }, error.message)
      const appError = notFound('Recurso não encontrado')
      return reply
        .status(appError.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(toProblemDetails(appError, traceId))
    }

    logger.error({ traceId, err: error, path: request.url }, 'erro não tratado')
    return reply.status(500).type(PROBLEM_CONTENT_TYPE).send({
      type: 'https://docs.petshopai.com/errors/ERR_INTERNAL',
      title: 'Erro interno',
      status: 500,
      code: 'ERR_INTERNAL',
      detail: 'Não foi possível concluir a operação. Tente novamente.',
      traceId,
    })
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const appError = notFound('Rota não encontrada')
    return reply
      .status(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(toProblemDetails(appError, request.id))
  })
}
