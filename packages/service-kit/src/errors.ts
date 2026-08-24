import { AppError, toProblemDetails, type FieldError } from '@petshop/shared-types'
import { TenantContextMissingError } from '@petshop/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Logger } from 'pino'
import { ZodError } from 'zod'

/**
 * Tradução de erro para `application/problem+json` (PRDs §5).
 *
 * Um handler único garante que nenhuma rota invente formato próprio e que detalhe
 * interno — SQL, host, PII — nunca escape para o cliente.
 *
 * O **catálogo** (quais códigos `ERR_<MOD>_NNN` existem e o que cada um significa)
 * continua em cada serviço: é ali que ele é lido junto com as regras que o produzem.
 * O que mora aqui é só a tradução.
 */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(raiz)',
    message: issue.message,
  }))
}

/**
 * Ramo extra de tradução, para erro que só um serviço conhece. Devolve o `AppError`
 * equivalente, ou `null` para deixar o erro seguir para os ramos seguintes.
 *
 * É como o pet-service transforma o estouro de limite do `@fastify/multipart` — que
 * chega com código próprio da biblioteca, não como exceção nossa — no mesmo 422 de
 * arquivo inválido que a validação manual produz.
 */
export type ErrorBranch = (error: unknown) => AppError | null

export interface ErrorHandlerConfig {
  logger: Logger
  /** O 422 do catálogo do serviço. */
  validationError: (error: ZodError, detail?: string) => AppError
  /**
   * O 404 do catálogo do serviço. Responde por três coisas: rota inexistente,
   * recurso ausente e — deliberadamente — violação de RLS.
   */
  notFound: (detail?: string) => AppError
  branches?: ErrorBranch[]
}

export function registerErrorHandler(app: FastifyInstance, config: ErrorHandlerConfig): void {
  const { logger, validationError, notFound, branches = [] } = config

  function sendProblem(reply: FastifyReply, error: AppError, traceId: string) {
    return reply
      .status(error.status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(toProblemDetails(error, traceId))
  }

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.id

    if (error instanceof AppError) {
      // Erro de negócio esperado: log em nível baixo, sem stack.
      logger.info(
        { traceId, code: error.code, status: error.status, path: request.url },
        error.message,
      )
      return sendProblem(reply, error, traceId)
    }

    if (error instanceof ZodError) {
      return sendProblem(reply, validationError(error), traceId)
    }

    for (const branch of branches) {
      const translated = branch(error)
      if (translated) {
        logger.info(
          { traceId, code: translated.code, status: translated.status, path: request.url },
          translated.message,
        )
        return sendProblem(reply, translated, traceId)
      }
    }

    if (error instanceof TenantContextMissingError) {
      // Bug de programação: alguém tocou tabela com RLS fora de withTenant().
      logger.error({ traceId, code: 'TENANT_CONTEXT_MISSING', path: request.url }, error.message)
      return sendProblem(reply, notFound('Recurso não encontrado'), traceId)
    }

    logger.error({ traceId, err: error, path: request.url }, 'erro não tratado')
    return reply.status(500).type(PROBLEM_CONTENT_TYPE).send({
      type: 'https://docs.petshopai.com/errors/ERR_INTERNAL',
      title: 'Erro interno',
      status: 500,
      code: 'ERR_INTERNAL',
      // Nunca devolver a mensagem original: ela pode carregar SQL, host ou PII.
      detail: 'Não foi possível concluir a operação. Tente novamente.',
      traceId,
    })
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    sendProblem(reply, notFound('Rota não encontrada'), request.id),
  )
}
