import { z } from 'zod'
import { MAX_MONEY_CENTS } from './money.js'
import { PLANS } from './plans.js'

/**
 * MOD-ADMIN — contratos da administração da plataforma
 * (PRD observabilidade_admin_14 §5).
 *
 * O que este arquivo descreve é a superfície da **equipe PetShop AI**, não a de um
 * estabelecimento. Ela vive sob `/platform/v1`, resolve sessão de outro jeito — token sem
 * Organization mais linha viva em `platform_admins` — e nunca toca dado de negócio sem a
 * autorização do controlador, que é o MOD-ADMIN-02.
 */

/**
 * A concessão do papel de plataforma (MOD-ADMIN-01, AC-04).
 *
 * O e-mail é o identificador porque é o que a pessoa sabe dizer; o produto o converte em
 * `email_hash` antes de procurar, que é como toda busca por e-mail funciona aqui — a
 * coluna em claro não existe.
 */
export const GrantPlatformAdminSchema = z.strictObject({
  email: z.email().max(254),
})
export type GrantPlatformAdminInput = z.output<typeof GrantPlatformAdminSchema>

export const PlatformAdminResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  fullName: z.string(),
  grantedAt: z.iso.datetime(),
  /** Nulo só na linha de bootstrap: não havia quem concedesse. */
  grantedBy: z.uuid().nullable(),
})
export type PlatformAdminResponse = z.output<typeof PlatformAdminResponseSchema>

/**
 * A lista de quem é da plataforma.
 *
 * Envelopada em `items` como todas as listas curtas do produto — o envelope é o que deixa
 * a resposta crescer (uma contagem, um aviso de corte) sem quebrar quem já a lê.
 */
export const PlatformAdminsResponseSchema = z.object({
  items: z.array(PlatformAdminResponseSchema),
})
export type PlatformAdminsResponse = z.output<typeof PlatformAdminsResponseSchema>

/**
 * O pedido de acesso do suporte (MOD-ADMIN-02, AC-01).
 *
 * `reason` tem mínimo de dez caracteres, e não é rigor gratuito: é o texto que o
 * administrador do petshop lê para decidir se aprova. "suporte" não é motivo — "chamado
 * #482, tutor relata recibo não recebido" é.
 */
export const RequestSupportAccessSchema = z.strictObject({
  reason: z.string().trim().min(10).max(300),
})
export type RequestSupportAccessInput = z.output<typeof RequestSupportAccessSchema>

/**
 * A aprovação, com o prazo que o estabelecimento escolhe.
 *
 * O teto do schema é 168h (uma semana) e o do servidor é `SUPPORT_GRANT_MAX_HOURS`, que é
 * menor. Os dois existem: o schema recusa o absurdo, e o ambiente decide a política.
 */
export const ApproveSupportAccessSchema = z.strictObject({
  hours: z.coerce.number().int().min(1).max(168).default(24),
})
export type ApproveSupportAccessInput = z.output<typeof ApproveSupportAccessSchema>

export const SUPPORT_GRANT_STATUSES = [
  'REQUESTED',
  'ACTIVE',
  'DENIED',
  'EXPIRED',
  'REVOKED',
] as const

export const SupportGrantResponseSchema = z.object({
  id: z.uuid(),
  status: z.enum(SUPPORT_GRANT_STATUSES),
  reason: z.string(),
  requestedBy: z.object({ userId: z.uuid(), fullName: z.string() }),
  requestedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
})
export type SupportGrantResponse = z.output<typeof SupportGrantResponseSchema>

/** A resposta da lista de grants de um estabelecimento, para a tela dele. */
export const SupportGrantsResponseSchema = z.object({
  items: z.array(SupportGrantResponseSchema),
})
export type SupportGrantsResponse = z.output<typeof SupportGrantsResponseSchema>

// ─── MOD-ADMIN-03 e 07 — o painel de tenants e o uso ─────────────────────────

/**
 * Os status de estabelecimento que o filtro aceita.
 *
 * **A lista tem sete valores, e o §5 do PRD escreve seis**: `PAST_DUE` existe no enum do
 * banco desde o MOD-IDENT e ficou de fora daquele trecho. Aceitar só os seis faria o
 * filtro recusar um estado que o painel mostra na coluna ao lado — divergência do
 * documento, e a favor do que o produto tem.
 */
export const PLATFORM_TENANT_STATUSES = [
  'PROVISIONING',
  'PROVISIONING_FAILED',
  'TRIAL',
  'TRIAL_EXPIRED',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'TERMINATED',
] as const
export type PlatformTenantStatus = (typeof PLATFORM_TENANT_STATUSES)[number]

export const PLATFORM_PLANS = PLANS

/**
 * A mensagem traz os valores aceitos (AC-03 de MOD-ADMIN-03).
 *
 * O padrão do Zod diz "Invalid option: expected one of …" em inglês, e quem lê um 422
 * desta superfície é quem está montando a chamada: a lista em claro é a diferença entre
 * corrigir na hora e abrir o código para descobrir o enum.
 */
export const TenantListQuerySchema = z.object({
  status: z
    .enum(PLATFORM_TENANT_STATUSES, {
      error: () => `Status inválido. Aceitos: ${PLATFORM_TENANT_STATUSES.join(', ')}`,
    })
    .optional(),
  plan: z
    .enum(PLATFORM_PLANS, { error: () => `Plano inválido. Aceitos: ${PLATFORM_PLANS.join(', ')}` })
    .optional(),
  /** Busca por nome ou slug. Nunca por dado de tutor — este painel não os alcança. */
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type TenantListQuery = z.output<typeof TenantListQuerySchema>

/**
 * As contagens do MOD-ADMIN-07 — e **só** contagens.
 *
 * A fronteira do módulo está aqui: nenhum destes campos identifica ninguém, nem quando o
 * denominador é um (AC-02). Nome, telefone e e-mail de tutor continuam atrás do grant de
 * suporte, que é decisão do estabelecimento e não da plataforma.
 */
export const TenantUsageSchema = z.object({
  tutors: z.number().int(),
  pets: z.number().int(),
  /** Atendimentos iniciados nos últimos 30 dias. */
  attendances30d: z.number().int(),
  /** Mensagens que saíram no mês civil corrente. */
  messagesThisMonth: z.number().int(),
  documents: z.number().int(),
  photoBytes: z.number().int(),
})
export type TenantUsage = z.output<typeof TenantUsageSchema>

/**
 * O provisionamento travado (AC-02 de MOD-ADMIN-03).
 *
 * Não-nulo apenas em `PROVISIONING_FAILED`: é o único estado em que o produto precisa de
 * intervenção humana da plataforma para destravar, e a contagem de tentativas mais o erro
 * da última são o que diz se vale reprocessar ou se falta algo no Clerk.
 */
export const TenantProvisioningSchema = z.object({
  attempts: z.number().int(),
  lastError: z.string().nullable(),
})

export const PlatformTenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(PLATFORM_TENANT_STATUSES),
  plan: z.enum(PLATFORM_PLANS),
  trialEndsAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  onboardingCompletedAt: z.iso.datetime().nullable(),
  /**
   * A última linha de trilha do estabelecimento.
   *
   * É proxy, e assumido como tal: `audit_logs` registra escrita, então um tenant que
   * passou a semana só consultando aparece parado. O sinal exato exigiria carimbar toda
   * requisição, que é escrita por leitura — caro justamente onde o produto é lido.
   */
  lastActivityAt: z.iso.datetime().nullable(),
  provisioning: TenantProvisioningSchema.nullable(),
  usage: TenantUsageSchema,
})
export type PlatformTenant = z.output<typeof PlatformTenantSchema>

/**
 * A troca de plano pelo console (fatia 2 da camada comercial).
 *
 * Enquanto não há cobrança, é a equipe da plataforma quem move o estabelecimento de
 * plano — e o motivo é obrigatório pela mesma razão que o do pedido de acesso: a trilha
 * que o estabelecimento lê precisa dizer por que o plano dele mudou.
 */
export const ChangeTenantPlanSchema = z.strictObject({
  plan: z.enum(PLATFORM_PLANS, {
    error: () => `Plano inválido. Aceitos: ${PLATFORM_PLANS.join(', ')}`,
  }),
  reason: z.string().trim().min(10).max(300),
})
export type ChangeTenantPlanInput = z.output<typeof ChangeTenantPlanSchema>

/**
 * O preço de um plano, mudado pelo console (camada comercial).
 *
 * **Vale para as assinaturas novas, e só para elas.** Quem já assina continua pagando o
 * que contratou — o valor está gravado na assinatura, aqui e no Asaas, e nada nesta rota
 * o reescreve. Reajustar a base é outra coisa, e teria de avisar cada cliente antes.
 *
 * O `reason` é o mesmo rigor da troca de plano: é o texto que explica, meses depois, por
 * que a tabela mudou naquele dia.
 */
export const UpdatePlanPriceSchema = z.strictObject({
  monthlyCents: z.number().int().min(100).max(MAX_MONEY_CENTS),
  yearlyCents: z.number().int().min(100).max(MAX_MONEY_CENTS),
  reason: z.string().trim().min(10).max(300),
})
export type UpdatePlanPriceInput = z.output<typeof UpdatePlanPriceSchema>

export const PlatformTenantPageSchema = z.object({
  data: z.array(PlatformTenantSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
})
export type PlatformTenantPage = z.output<typeof PlatformTenantPageSchema>

// ─── MOD-ADMIN-04 — a saúde da plataforma ────────────────────────────────────

export const PLATFORM_DEPENDENCIES = ['postgres', 'redis', 'rabbitmq', 'gotenberg'] as const
export type PlatformDependency = (typeof PLATFORM_DEPENDENCIES)[number]

/**
 * `DISABLED` não é falha, e a distinção importa.
 *
 * O processo sobe com Redis, broker e agendador desligados em teste e em instalação
 * mínima; pintar essas três de vermelho treinaria a equipe a ignorar a cor. O que é
 * vermelho é a dependência que deveria responder e não respondeu.
 */
export const DependencyHealthSchema = z.object({
  name: z.enum(PLATFORM_DEPENDENCIES),
  state: z.enum(['UP', 'DOWN', 'DISABLED']),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
})
export type DependencyHealth = z.output<typeof DependencyHealthSchema>

/**
 * O estado de um job na grade.
 *
 * `STALE` sai de **três vezes** o intervalo do cron (RN-12), e não de um número fixo de
 * minutos: o múltiplo trata igual o job de 15 em 15 minutos e o semanal, e um limite fixo
 * alarmaria o segundo todo dia enquanto deixaria o primeiro parado por horas em silêncio.
 */
export const JobHealthSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  state: z.enum(['OK', 'FAILING', 'STALE', 'NEVER_RUN']),
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(['OK', 'FAILED', 'TIMEOUT']).nullable(),
  lastDurationMs: z.number().int().nullable(),
  lastError: z.string().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  /**
   * O lease preso (AC-04): `lease_until` no passado sem execução depois dele.
   *
   * É o sintoma de réplica que morreu no meio do job, e este é o único lugar onde ele
   * aparece — o lease vence sozinho e a próxima passada segue normalmente, então nada no
   * log diz que alguém caiu segurando o job.
   */
  stuckLease: z.object({ holder: z.string(), leaseUntil: z.iso.datetime() }).nullable(),
})
export type JobHealth = z.output<typeof JobHealthSchema>

/** A profundidade da fila de saída de mensagens, por status. */
export const QueueDepthSchema = z.object({
  status: z.string(),
  count: z.number().int(),
})

export const PlatformHealthSchema = z.object({
  checkedAt: z.iso.datetime(),
  dependencies: z.array(DependencyHealthSchema),
  jobs: z.array(JobHealthSchema),
  messages: z.array(QueueDepthSchema),
})
export type PlatformHealth = z.output<typeof PlatformHealthSchema>

// ─── MOD-ADMIN-08 — a trilha cross-tenant ────────────────────────────────────

/**
 * A consulta da trilha da plataforma.
 *
 * Compartilha o teto de 92 dias e o cursor do MOD-SEC-05 — o mesmo desenho, com dois
 * filtros a mais: `tenantId`, que ali não faria sentido (a tela do tenant já está num), e
 * `action`, que é como se pergunta "o que o suporte leu?" (`action=support.read`).
 */
export const PlatformAuditQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  actorUserId: z.uuid().optional(),
  tenantId: z.uuid().optional(),
  action: z.string().max(60).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type PlatformAuditQuery = z.output<typeof PlatformAuditQuerySchema>

export const PlatformAuditEntrySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  outcome: z.enum(['ALLOWED', 'DENIED']),
  actorUserId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  actorEmailMasked: z.string().nullable(),
  /**
   * De que estabelecimento é a linha. Nulo é ação da própria plataforma — conceder papel,
   * ler esta trilha —, que é justamente o que a tela do tenant nunca mostra.
   */
  tenant: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }).nullable(),
  ipAddress: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
})
export type PlatformAuditEntry = z.output<typeof PlatformAuditEntrySchema>

export const PlatformAuditPageSchema = z.object({
  items: z.array(PlatformAuditEntrySchema),
  nextCursor: z.string().nullable(),
})
export type PlatformAuditPage = z.output<typeof PlatformAuditPageSchema>

// ─── MOD-ADMIN-05 — a série temporal ─────────────────────────────────────────

/**
 * A consulta da série (AC-02).
 *
 * `metric` é obrigatório e não tem catálogo: as 51 métricas do produto nascem no código
 * que as emite, e uma lista fechada aqui garantiria que a métrica mais nova — justamente
 * a do problema que se está investigando — fosse a que falta.
 */
export const PlatformMetricsQuerySchema = z.object({
  metric: z.string().min(1).max(60),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** `tenant` devolve uma linha por estabelecimento; `total` soma todos. */
  groupBy: z.enum(['tenant', 'total']).default('total'),
})
export type PlatformMetricsQuery = z.output<typeof PlatformMetricsQuerySchema>

/**
 * O tamanho do balde servido, que **não** é a resolução guardada.
 *
 * O banco guarda dois: cinco minutos por trinta dias, um dia por treze meses. A consulta
 * serve um terceiro, `HOUR`, agregando os baldes de cinco minutos quando a janela pedida é
 * longa demais para caber na tela — trinta dias em baldes de cinco minutos são 8.640
 * pontos, que é uma lista, não um gráfico.
 */
export const METRIC_BUCKET_SIZES = ['FIVE_MIN', 'HOUR', 'DAY'] as const
export type MetricBucketSize = (typeof METRIC_BUCKET_SIZES)[number]

export const PlatformMetricPointSchema = z.object({
  bucket: z.iso.datetime(),
  /** Nulo é a plataforma: a métrica que nasce sem tenant, ou a soma de todos. */
  tenantId: z.uuid().nullable(),
  sum: z.number(),
  count: z.number().int(),
  min: z.number(),
  max: z.number(),
  p95: z.number(),
})
export type PlatformMetricPoint = z.output<typeof PlatformMetricPointSchema>

export const PlatformMetricSeriesSchema = z.object({
  metric: z.string(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  bucketSize: z.enum(METRIC_BUCKET_SIZES),
  groupBy: z.enum(['tenant', 'total']),
  points: z.array(PlatformMetricPointSchema),
})
export type PlatformMetricSeries = z.output<typeof PlatformMetricSeriesSchema>

// ─── MOD-ADMIN-06 — alertas ──────────────────────────────────────────────────

export const PLATFORM_ALERT_STATUSES = ['PENDING', 'FIRING', 'RESOLVED'] as const
export type PlatformAlertStatusValue = (typeof PLATFORM_ALERT_STATUSES)[number]

export const PlatformAlertQuerySchema = z.object({
  status: z
    .enum(PLATFORM_ALERT_STATUSES, {
      error: () => `Estado inválido. Aceitos: ${PLATFORM_ALERT_STATUSES.join(', ')}`,
    })
    .optional(),
  rule: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type PlatformAlertQuery = z.output<typeof PlatformAlertQuerySchema>

export const PlatformAlertSchema = z.object({
  id: z.uuid(),
  rule: z.string(),
  /** A frase que o catálogo de regras dá à regra. O código sozinho não se lê. */
  ruleLabel: z.string(),
  status: z.enum(PLATFORM_ALERT_STATUSES),
  value: z.number(),
  tenant: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }).nullable(),
  firstSeenAt: z.iso.datetime(),
  lastEvaluatedAt: z.iso.datetime(),
  /**
   * Nulo enquanto o alerta é `PENDING`: a condição foi vista uma vez e ainda não valeu
   * duas avaliações seguidas. É o estado em que nada é notificado.
   */
  firedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
})
export type PlatformAlert = z.output<typeof PlatformAlertSchema>

export const PlatformAlertsResponseSchema = z.object({
  items: z.array(PlatformAlertSchema),
})
export type PlatformAlertsResponse = z.output<typeof PlatformAlertsResponseSchema>
