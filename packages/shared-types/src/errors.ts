/**
 * Catálogo de erros do módulo de identidade e o formato `application/problem+json`
 * (PRD identidade_tenancy_01 §5).
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
}

/**
 * Erro de domínio carregando o código do catálogo. O error handler de cada serviço
 * o converte em `application/problem+json`.
 */
export class AppError extends Error {
  readonly code: IdentityErrorCode
  readonly status: number
  readonly fieldErrors: FieldError[] | undefined

  constructor(code: IdentityErrorCode, detail: string, fieldErrors?: FieldError[]) {
    super(detail)
    this.name = 'AppError'
    this.code = code
    this.status = IDENTITY_ERRORS[code].status
    this.fieldErrors = fieldErrors
  }
}

export function toProblemDetails(error: AppError, traceId: string): ProblemDetails {
  const problem: ProblemDetails = {
    type: `${ERROR_DOCS_BASE_URL}/${error.code}`,
    title: IDENTITY_ERRORS[error.code].title,
    status: error.status,
    code: error.code,
    detail: error.message,
    traceId,
  }
  if (error.fieldErrors?.length) problem.errors = error.fieldErrors
  return problem
}
