import { z } from 'zod'

/**
 * MOD-SEC — contratos de leitura da trilha e dos eventos de segurança
 * (PRD seguranca_compliance_13 §5).
 *
 * O módulo não tem contrato de **escrita**: nada aqui cria linha. A trilha nasce de
 * `recordAudit` dentro da transação de quem alterou algo, e o evento de segurança nasce
 * de uma recusa. O que este arquivo descreve é só como se lê o que já foi escrito.
 */

export const SECURITY_EVENT_TYPES = [
  'CROSS_TENANT_ATTEMPT',
  'PERMISSION_DENIED',
  'TENANT_CONTEXT_MISSING',
  'WEBHOOK_SIGNATURE_INVALID',
  'LOGIN_FAILED',
  'MFA_REQUIRED',
] as const

export type SecurityEventTypeKey = (typeof SECURITY_EVENT_TYPES)[number]

export const SECURITY_EVENT_LABELS: Record<SecurityEventTypeKey, string> = {
  CROSS_TENANT_ATTEMPT: 'Tentativa de acessar dado de outro estabelecimento',
  PERMISSION_DENIED: 'Ação negada por falta de permissão',
  TENANT_CONTEXT_MISSING: 'Consulta sem contexto de estabelecimento',
  WEBHOOK_SIGNATURE_INVALID: 'Assinatura inválida em chamada externa',
  LOGIN_FAILED: 'Falha de acesso ao Portal do Tutor',
  MFA_REQUIRED: 'Ação bloqueada por falta de verificação em duas etapas',
}

/**
 * A janela máxima de uma consulta.
 *
 * Não é limite de desempenho: é forma de uso. Sem teto, a primeira coisa que alguém faz
 * é pedir dois anos de trilha e receber uma página de cinquenta linhas de anteontem.
 * Noventa e dois dias é um trimestre, que é o recorte de quem investiga.
 */
export const AUDIT_QUERY_MAX_DAYS = 92

/** Sem `from`/`to`, a tela abre nos últimos trinta dias. */
export const AUDIT_QUERY_DEFAULT_DAYS = 30

export const AUDIT_PAGE_SIZE = 50

const paging = {
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  actorUserId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE).default(AUDIT_PAGE_SIZE),
}

export const AuditLogQuerySchema = z.object({
  ...paging,
  entity: z.string().max(60).optional(),
  entityId: z.string().max(60).optional(),
  outcome: z.enum(['ALLOWED', 'DENIED']).optional(),
})

export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>

/**
 * **Dois schemas escritos por extenso, e não um derivado do outro por `.partial()`.**
 *
 * O `.partial()` do Zod não remove `default()`: o campo vira opcional na entrada e
 * continua sendo preenchido na saída. Já custou um defeito neste repositório, num PATCH
 * que gravava o padrão por cima do que o tenant tinha customizado. Aqui os dois
 * compartilham o bloco `paging` por composição, que é explícito e não tem esse efeito.
 */
export const SecurityEventQuerySchema = z.object({
  ...paging,
  type: z.enum(SECURITY_EVENT_TYPES).optional(),
  summary: z.stringbool().default(false),
})

export type SecurityEventQuery = z.infer<typeof SecurityEventQuerySchema>

/** Quem agiu. `SYSTEM` é job — não há pessoa a nomear. */
export const AuditActorKindSchema = z.enum(['USER', 'SYSTEM'])
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>

const actorFields = {
  actorKind: AuditActorKindSchema,
  actorUserId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  /**
   * O e-mail do ator, mascarado.
   *
   * Quem lê a trilha está auditando colegas: precisa distinguir duas pessoas de mesmo
   * nome, não obter a lista de e-mails da equipe por uma rota que não passa pelo
   * `team:read`.
   */
  actorEmailMasked: z.string().nullable(),
}

export const AuditLogEntrySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  outcome: z.enum(['ALLOWED', 'DENIED']),
  ...actorFields,
  ipAddress: z.string().nullable(),
  /** Já redigido na escrita por `sanitize()`. Não existe caminho de desredação. */
  before: z.unknown(),
  after: z.unknown(),
})
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>

export const SecurityEventEntrySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  type: z.enum(SECURITY_EVENT_TYPES),
  ...actorFields,
  targetEntity: z.string().nullable(),
  targetId: z.string().nullable(),
  ipAddress: z.string().nullable(),
})
export type SecurityEventEntry = z.infer<typeof SecurityEventEntrySchema>

/** `nextCursor` nulo é a última página. Não há total: contar dois anos de trilha a cada
 * abertura de tela é uma varredura por curiosidade. */
export const AuditLogPageSchema = z.object({
  items: z.array(AuditLogEntrySchema),
  nextCursor: z.string().nullable(),
})
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>

export const SecurityEventPageSchema = z.object({
  items: z.array(SecurityEventEntrySchema),
  nextCursor: z.string().nullable(),
})
export type SecurityEventPage = z.infer<typeof SecurityEventPageSchema>

export const SecurityEventSummarySchema = z.object({
  type: z.enum(SECURITY_EVENT_TYPES),
  count: z.number().int(),
})
export type SecurityEventSummary = z.infer<typeof SecurityEventSummarySchema>

export const SecurityEventSummaryResponseSchema = z.object({
  items: z.array(SecurityEventSummarySchema),
})

export interface AuditPage<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * O estado de MFA que o `GET /v1/me` passa a devolver (MOD-SEC-02 AC-04).
 *
 * `required` é `false` para todo papel que não seja `TENANT_ADMIN`. `graceEndsAt` no
 * futuro significa que a tela mostra faixa de aviso; no passado, tela de bloqueio.
 */
export interface MfaState {
  required: boolean
  enabled: boolean
  graceEndsAt: string | null
}
