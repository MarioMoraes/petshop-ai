import { AppError, type FieldError } from '@petshop/shared-types'
import {
  registerErrorHandler as registerKitErrorHandler,
  zodToFieldErrors,
} from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * O error handler do processo — **um só**, no nível do app.
 *
 * O catálogo de cada módulo continua com o módulo (`modules/site/errors.ts` e os que
 * vierem): é lá que se lê o código junto da regra que o produz. O que fica aqui é a
 * rede de segurança do host, para o erro que chega sem código nenhum:
 *
 * - `ZodError` cru que escapou de um `parseInput` — 422 genérico;
 * - violação de RLS (`TenantContextMissingError`) — 404, deliberadamente;
 * - rota inexistente — 404;
 * - estouro de rate limit — 429;
 * - o resto — 500 sem a mensagem original, que pode carregar SQL, host ou PII.
 *
 * O `AppError` que um módulo lança passa por aqui já resolvido, com o código e o
 * status do próprio catálogo. A rede só pega o que ninguém traduziu.
 */

/** O 422 do host. O módulo que valida com `parseInput` nunca chega aqui. */
export function validationError(error: ZodError, detail?: string): AppError {
  const fields: FieldError[] = zodToFieldErrors(error)
  return new AppError(
    'ERR_IDENT_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

/** O 404 do host: rota que não existe e recurso que o RLS escondeu. */
export function notFound(detail = 'Recurso não encontrado'): AppError {
  return new AppError('ERR_IDENT_001', detail)
}

export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_IDENT_003', detail)
}

/**
 * O plugin de rate limit sinaliza pelo status, não por um tipo próprio — daí o
 * ramo em vez de um `instanceof`.
 */
function rateLimitBranch(error: unknown): AppError | null {
  if ((error as { statusCode?: number })?.statusCode !== 429) return null
  return new AppError(
    'ERR_RATE_LIMITED',
    'Você fez muitas requisições. Aguarde um instante.',
  )
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, {
    logger,
    validationError,
    notFound,
    branches: [rateLimitBranch],
  })
}
