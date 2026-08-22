/**
 * Catálogo de erros e o formato `application/problem+json`
 * (PRD identidade_tenancy_01 §5, PRD tutores_02 §5).
 *
 * Cada módulo acrescenta o próprio bloco `ERR_<MODULO>_NNN`; `AppError` aceita
 * qualquer código do catálogo unificado, e o `status` sai daqui — nunca de um número
 * escrito à mão na rota.
 */

export const IDENTITY_ERRORS = {
  ERR_IDENT_001: { status: 404, title: 'Recurso não encontrado' },
  ERR_IDENT_002: { status: 422, title: 'Dados de entrada inválidos' },
  ERR_IDENT_003: { status: 403, title: 'Permissão insuficiente' },
  ERR_IDENT_004: { status: 409, title: 'Conflito de recurso' },
  ERR_IDENT_005: { status: 401, title: 'Credenciais inválidas' },
  ERR_IDENT_006: { status: 410, title: 'Convite expirado ou revogado' },
  ERR_IDENT_007: { status: 402, title: 'Limite do plano atingido' },
  ERR_IDENT_008: { status: 423, title: 'Estabelecimento suspenso' },
} as const

export type IdentityErrorCode = keyof typeof IDENTITY_ERRORS

/** PRD tutores_02 §5. */
export const TUTOR_ERRORS = {
  ERR_TUTOR_001: { status: 404, title: 'Tutor não encontrado' },
  ERR_TUTOR_002: { status: 422, title: 'Dados de entrada inválidos' },
  ERR_TUTOR_003: { status: 403, title: 'Permissão insuficiente' },
  ERR_TUTOR_004: { status: 409, title: 'Cadastro duplicado' },
  ERR_TUTOR_005: { status: 409, title: 'Exclusão bloqueada por histórico' },
  ERR_TUTOR_006: { status: 409, title: 'Cadastro em estado terminal' },
  ERR_TUTOR_007: { status: 422, title: 'Unificação inválida' },
  ERR_TUTOR_008: { status: 502, title: 'Serviço de CEP indisponível' },
  ERR_TUTOR_009: { status: 403, title: 'Comunicação bloqueada por consentimento' },
} as const

export type TutorErrorCode = keyof typeof TUTOR_ERRORS

export const ERROR_CATALOG = { ...IDENTITY_ERRORS, ...TUTOR_ERRORS } as const

export type ErrorCode = keyof typeof ERROR_CATALOG

export const ERROR_DOCS_BASE_URL = 'https://docs.petshopai.com/errors'

export interface FieldError {
  field: string
  message: string
}

export interface ProblemDetails {
  type: string
  title: string
  status: number
  code: string
  detail: string
  traceId: string
  errors?: FieldError[]
  /** Campos específicos do erro, como `existingTutor` em ERR_TUTOR_004. */
  [key: string]: unknown
}

/**
 * Erro de domínio carregando o código do catálogo. O error handler de cada serviço
 * o converte em `application/problem+json`.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly fieldErrors: FieldError[] | undefined
  /** Contexto extra do problem+json — ex.: `existingTutor` no 409 de duplicata. */
  readonly extra: Record<string, unknown> | undefined

  constructor(
    code: ErrorCode,
    detail: string,
    fieldErrors?: FieldError[],
    extra?: Record<string, unknown>,
  ) {
    super(detail)
    this.name = 'AppError'
    this.code = code
    this.status = ERROR_CATALOG[code].status
    this.fieldErrors = fieldErrors
    this.extra = extra
  }
}

export function toProblemDetails(error: AppError, traceId: string): ProblemDetails {
  const problem: ProblemDetails = {
    type: `${ERROR_DOCS_BASE_URL}/${error.code}`,
    title: ERROR_CATALOG[error.code].title,
    status: error.status,
    code: error.code,
    detail: error.message,
    traceId,
    ...(error.extra ?? {}),
  }
  if (error.fieldErrors?.length) problem.errors = error.fieldErrors
  return problem
}
