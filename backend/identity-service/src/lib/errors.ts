import { AppError, toProblemDetails, type FieldError } from '@petshop/shared-types'
import { TenantContextMissingError } from '@petshop/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Tradução de erro para `application/problem+json` (PRD identidade_tenancy_01 §5).
 *
 * Um handler único garante que nenhuma rota invente formato de erro próprio e que
 * detalhe interno nunca escape para o cliente.
 */

const PROBLEM_CONTENT_TYPE = 'application/problem+json'

function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(raiz)',
    message: issue.message,
  }))
}

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
      const appError = new AppError('ERR_IDENT_001', 'Recurso não encontrado')
      return reply
        .status(appError.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(toProblemDetails(appError, traceId))
    }

    logger.error({ traceId, err: error, path: request.url }, 'erro não tratado')
    return reply
      .status(500)
      .type(PROBLEM_CONTENT_TYPE)
      .send({
        type: 'https://docs.petshopai.com/errors/ERR_INTERNAL',
        title: 'Erro interno',
        status: 500,
        code: 'ERR_INTERNAL',
        // Nunca devolver a mensagem original: ela pode carregar SQL, host ou PII.
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
