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

/** PRD pets_03 §5. */
export const PET_ERRORS = {
  ERR_PET_001: { status: 404, title: 'Pet não encontrado' },
  ERR_PET_002: { status: 422, title: 'Dados de entrada inválidos' },
  ERR_PET_003: { status: 403, title: 'Permissão insuficiente' },
  ERR_PET_004: { status: 409, title: 'Conflito de cadastro' },
  ERR_PET_005: { status: 409, title: 'Operação bloqueada por vínculo' },
  ERR_PET_006: { status: 409, title: 'Item de domínio em uso' },
  ERR_PET_007: { status: 422, title: 'Arquivo de imagem inválido' },
  ERR_PET_008: { status: 402, title: 'Cota de fotos do plano atingida' },
  ERR_PET_009: { status: 502, title: 'Falha no serviço de imagens' },
  ERR_PET_010: { status: 403, title: 'Uso de imagem sem consentimento' },

  // MOD-PRONT — prontuário clínico e comportamental
  ERR_PRONT_001: { status: 404, title: 'Registro não encontrado' },
  ERR_PRONT_002: { status: 422, title: 'Dados de entrada inválidos' },
  ERR_PRONT_003: { status: 403, title: 'Permissão clínica insuficiente' },
  ERR_PRONT_004: { status: 409, title: 'Atendimento já registrado' },
  ERR_PRONT_005: { status: 409, title: 'Serviço incompatível com alergia crítica' },
  ERR_PRONT_006: { status: 409, title: 'Registro imutável' },
  ERR_PRONT_007: { status: 409, title: 'Vacinação obrigatória pendente' },
  ERR_PRONT_008: { status: 422, title: 'Anexo inválido' },
  ERR_PRONT_009: { status: 403, title: 'Prescrição exige CRMV' },
} as const

export type PetErrorCode = keyof typeof PET_ERRORS

/** PRD agenda_operacao_06 §5. */
export const AGENDA_ERRORS = {
  ERR_AGENDA_001: { status: 404, title: 'Agendamento não encontrado' },
  ERR_AGENDA_002: { status: 422, title: 'Dados de entrada inválidos' },
  ERR_AGENDA_003: { status: 403, title: 'Permissão insuficiente' },
  ERR_AGENDA_004: { status: 409, title: 'Capacidade do profissional esgotada' },
  ERR_AGENDA_005: { status: 409, title: 'Profissional indisponível no horário' },
  ERR_AGENDA_006: { status: 409, title: 'Transição de status inválida' },
  ERR_AGENDA_007: { status: 422, title: 'Antecedência mínima não respeitada' },
  ERR_AGENDA_008: { status: 409, title: 'Débito acima do limite' },
  ERR_AGENDA_009: { status: 409, title: 'Alerta clínico crítico não reconhecido' },
  ERR_AGENDA_010: { status: 409, title: 'Pet ou tutor indisponível' },
  ERR_AGENDA_011: { status: 409, title: 'Serviço em uso' },
  ERR_AGENDA_012: { status: 409, title: 'Profissional com agendamentos futuros' },
} as const

export type AgendaErrorCode = keyof typeof AGENDA_ERRORS

/** PRD financeiro_tutor_05 §5. */
export const LEDGER_ERRORS = {
  ERR_LEDGER_001: { status: 404, title: 'Registro financeiro não encontrado' },
  ERR_LEDGER_002: { status: 422, title: 'Valor inválido para lançamento' },
  ERR_LEDGER_003: { status: 422, title: 'Forma de pagamento não habilitada' },
  ERR_LEDGER_004: { status: 409, title: 'Lançamento ou pagamento já estornado' },
  ERR_LEDGER_005: { status: 409, title: 'Lançamento imutável' },
  ERR_LEDGER_006: { status: 409, title: 'Limite de crédito excedido' },
  ERR_LEDGER_007: { status: 409, title: 'Pacote indisponível' },
  ERR_LEDGER_008: { status: 422, title: 'Serviço não coberto pelo pacote' },
  ERR_LEDGER_009: { status: 409, title: 'Alocação inválida' },
  ERR_LEDGER_010: { status: 403, title: 'Permissão financeira insuficiente' },
  ERR_LEDGER_011: { status: 409, title: 'Conta em revisão de consistência' },
  ERR_LEDGER_012: { status: 409, title: 'Chave de idempotência reutilizada' },
} as const

export type LedgerErrorCode = keyof typeof LEDGER_ERRORS

/** PRD taxi_dog_07 §5. */
export const TAXI_ERRORS = {
  ERR_TAXI_001: { status: 404, title: 'Corrida não encontrada' },
  ERR_TAXI_002: { status: 422, title: 'Corrida sem agendamento' },
  ERR_TAXI_003: { status: 422, title: 'Janela ou horário inválido' },
  ERR_TAXI_004: { status: 409, title: 'Perna já solicitada neste agendamento' },
  ERR_TAXI_005: { status: 422, title: 'Endereço de coleta ausente' },
  ERR_TAXI_006: { status: 409, title: 'Motorista indisponível na janela' },
  ERR_TAXI_007: { status: 409, title: 'Capacidade do veículo esgotada' },
  ERR_TAXI_008: { status: 409, title: 'Transição de status inválida' },
  ERR_TAXI_009: { status: 403, title: 'Permissão insuficiente' },
  ERR_TAXI_010: { status: 422, title: 'Serviço de Taxi Dog não configurado' },
  ERR_TAXI_011: { status: 422, title: 'CEP fora das zonas atendidas' },
  ERR_TAXI_012: { status: 409, title: 'Prefixo de CEP já coberto' },
  ERR_TAXI_013: { status: 409, title: 'Zona ou veículo em uso' },
  ERR_TAXI_014: { status: 409, title: 'Taxi Dog desligado neste estabelecimento' },
} as const

export type TaxiErrorCode = keyof typeof TAXI_ERRORS

/**
 * PRD relacionamento_crm_08 §5.
 *
 * Note o que **não** está aqui: falta de consentimento. O chamador pediu certo, e a
 * resposta correta é uma mensagem `BLOCKED` com o motivo — um 4xx faria cada
 * consumidor de evento distinguir "eu errei" de "o tutor não quer", e a tentação seria
 * tratar as duas como falha e reprocessar para sempre.
 */
export const CRM_ERRORS = {
  ERR_CRM_001: { status: 404, title: 'Mensagem não encontrada' },
  ERR_CRM_002: { status: 422, title: 'Texto de mensagem desconhecido' },
  ERR_CRM_003: { status: 422, title: 'Dados de entrada inválidos' },
  ERR_CRM_004: { status: 409, title: 'Texto de sistema não pode ser excluído' },
  ERR_CRM_005: { status: 409, title: 'WhatsApp não conectado' },
  ERR_CRM_006: { status: 422, title: 'Automação ou campanha mal configurada' },
  ERR_CRM_007: { status: 409, title: 'Transição inválida para esta mensagem' },
  ERR_CRM_008: { status: 429, title: 'Limite de envio atingido' },
  ERR_CRM_009: { status: 409, title: 'Campanha já em execução' },
  ERR_CRM_010: { status: 409, title: 'Contagem de destinatários divergente' },
  ERR_CRM_011: { status: 422, title: 'Segmento vazio' },
  ERR_CRM_012: { status: 403, title: 'Permissão insuficiente' },
  ERR_CRM_013: { status: 409, title: 'Mensagens desligadas neste estabelecimento' },
  ERR_CRM_014: { status: 401, title: 'Webhook com assinatura inválida' },
  ERR_CRM_015: { status: 502, title: 'Provedor de mensagens indisponível' },
  ERR_CRM_016: { status: 422, title: 'Destinatário suprimido' },
} as const

export type CrmErrorCode = keyof typeof CRM_ERRORS

/** PRD site_tenant_10 §5. */
export const SITE_ERRORS = {
  ERR_SITE_001: { status: 422, title: 'Faltam dados para publicar o site' },
  ERR_SITE_002: { status: 422, title: 'Endereço inválido' },
  ERR_SITE_003: { status: 422, title: 'Limite da galeria atingido' },
  ERR_SITE_004: { status: 429, title: 'Muitos envios deste endereço' },
  ERR_SITE_005: { status: 422, title: 'Dados de contato inválidos' },
  ERR_SITE_006: { status: 404, title: 'Site não encontrado' },
  ERR_SITE_007: { status: 409, title: 'Domínio já reivindicado por outro estabelecimento' },
  ERR_SITE_008: { status: 403, title: 'Permissão insuficiente' },
  ERR_SITE_009: { status: 404, title: 'Foto não encontrada' },
  ERR_SITE_010: { status: 404, title: 'Contato não encontrado' },
  ERR_SITE_011: { status: 409, title: 'Transição inválida para este contato' },
  ERR_SITE_012: { status: 502, title: 'Armazenamento de mídia indisponível' },
} as const

export type SiteErrorCode = keyof typeof SITE_ERRORS

export const ERROR_CATALOG = {
  ...IDENTITY_ERRORS,
  ...TUTOR_ERRORS,
  ...PET_ERRORS,
  ...AGENDA_ERRORS,
  ...LEDGER_ERRORS,
  ...TAXI_ERRORS,
  ...CRM_ERRORS,
  ...SITE_ERRORS,
} as const

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
