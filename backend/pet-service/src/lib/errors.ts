import { AppError, toProblemDetails, type FieldError } from '@petshop/shared-types'
import { TenantContextMissingError } from '@petshop/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Tradução de erro para `application/problem+json` (PRD pets_03 §5).
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
    'ERR_PET_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Pet não encontrado'): AppError {
  return new AppError('ERR_PET_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_PET_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_PET_003', detail)
}

/**
 * Requisição que chegou sem a assinatura do gateway. Usa o código de identidade de
 * propósito: quem não se autenticou não chegou a tocar em nenhum pet.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/**
 * 409 de conflito. RN-15 e AC-02 de MOD-PET-02 mandam o corpo carregar o registro
 * existente: um microchip duplicado quase sempre é erro de digitação, e a UI precisa
 * poder abrir o cadastro que já existe em vez de só dizer "não".
 */
export function conflict(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_004', detail, undefined, extra)
}

/** AC-03 de MOD-PET-02 e AC-02 de MOD-PET-05: bloqueio por vínculo existente. */
export function blockedByLink(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_005', detail, undefined, extra)
}

/** AC-04 de MOD-PET-03: item de domínio em uso não pode ser excluído. */
export function domainInUse(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_006', detail, undefined, extra)
}

/**
 * AC-02 de MOD-PET-04: arquivo que não é imagem, é grande demais ou está corrompido.
 * A `cause` fica no log e nunca no corpo — mensagem de erro de biblioteca de imagem
 * não diz nada a quem está no balcão.
 */
export function invalidFile(detail: string, cause?: unknown): AppError {
  if (cause) logger.debug({ err: cause }, 'arquivo de imagem recusado')
  return new AppError('ERR_PET_007', detail)
}

/** AC-03 de MOD-PET-04: cota de fotos do plano atingida. */
export function quotaExceeded(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_008', detail, undefined, extra)
}

/**
 * AC-04 de MOD-PET-04: o storage falhou. 502 e não 500 — o defeito não é nosso, e a
 * distinção importa para quem lê o alerta às três da manhã.
 */
export function storageFailure(detail = 'Não conseguimos guardar a imagem agora. Tente de novo em instantes.'): AppError {
  return new AppError('ERR_PET_009', detail)
}

/** AC-05 de MOD-PET-04: uso de imagem sem o consentimento IMAGE_USE do tutor. */
export function consentMissing(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_PET_010', detail, undefined, extra)
}

const MULTIPART_LIMIT_CODES = new Set([
  'FST_REQ_FILE_TOO_LARGE',
  'FST_FILES_LIMIT',
  'FST_FIELDS_LIMIT',
  'FST_PARTS_LIMIT',
])

function isMultipartLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    MULTIPART_LIMIT_CODES.has((error as { code: string }).code)
  )
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

    // O `@fastify/multipart` estoura com códigos próprios quando o arquivo passa do
    // limite. É entrada inválida (AC-02), não erro de servidor — e a mensagem tem de
    // ser a mesma do resto da validação de arquivo.
    if (isMultipartLimitError(error)) {
      const appError = invalidFile('Formato inválido. Envie JPG, PNG, WEBP ou HEIC de até 10 MB.')
      logger.info({ traceId, code: appError.code, path: request.url }, 'upload acima do limite')
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
