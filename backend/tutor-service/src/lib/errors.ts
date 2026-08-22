import { AppError, toProblemDetails, type FieldError } from '@petshop/shared-types'
import { TenantContextMissingError } from '@petshop/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Tradução de erro para `application/problem+json` (PRD tutores_02 §5).
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
    'ERR_TUTOR_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Tutor não encontrado'): AppError {
  return new AppError('ERR_TUTOR_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_TUTOR_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_TUTOR_003', detail)
}

/**
 * Requisição que chegou sem a assinatura do gateway. Usa o código de identidade de
 * propósito: quem não se autenticou não chegou a tocar em nenhum tutor.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/** AC-01 de MOD-TUTOR-02: o 409 carrega o cadastro existente, para a UI oferecer abri-lo. */
export function duplicateConflict(detail: string, existingTutor: Record<string, unknown>): AppError {
  return new AppError('ERR_TUTOR_004', detail, undefined, { existingTutor })
}

/**
 * AC-02/AC-03: duplicata **provável**. Mesmo código, corpo diferente — aqui vai a
 * lista de candidatos, e o cliente reenvia com `duplicateAcknowledged` se for outra
 * pessoa. Não é um cadastro existente que se abre; é uma dúvida que se resolve.
 */
export function duplicateWarning(
  detail: string,
  extra: { candidates: unknown[]; confidence: string | null },
): AppError {
  return new AppError('ERR_TUTOR_004', detail, undefined, {
    ...extra,
    requiresAcknowledgement: true,
  })
}

export function blockedByHistory(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TUTOR_005', detail, undefined, extra)
}

export function terminalState(detail: string): AppError {
  return new AppError('ERR_TUTOR_006', detail)
}

export function invalidMerge(detail: string): AppError {
  return new AppError('ERR_TUTOR_007', detail)
}

export function cepUnavailable(detail = 'Não foi possível consultar o CEP. Preencha o endereço manualmente.'): AppError {
  return new AppError('ERR_TUTOR_008', detail)
}

export function blockedByConsent(detail: string): AppError {
  return new AppError('ERR_TUTOR_009', detail)
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
