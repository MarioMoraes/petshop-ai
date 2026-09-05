import { z } from 'zod'

/**
 * PRD relacionamento_crm_08 §5 — contratos do messaging-service e do
 * crm-automation-service.
 *
 * O motor de saída é **um só** para WhatsApp e e-mail (divergência consciente do
 * SPEC §2, registrada na §1 do PRD): fila, retry, dedupe, janela de silêncio,
 * consentimento e criptografia do corpo são iguais nos dois canais, e dois motores
 * significaria dois históricos para o mesmo tutor.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

export const MessageChannelSchema = z.enum(['WHATSAPP', 'EMAIL'])
export type MessageChannel = z.infer<typeof MessageChannelSchema>

/** `AUTO` escolhe o canal na hora, olhando consentimento e disponibilidade (AC-02). */
export const MessageChannelPrefSchema = z.enum(['AUTO', 'WHATSAPP', 'EMAIL'])
export type MessageChannelPref = z.infer<typeof MessageChannelPrefSchema>

export const MessageDirectionSchema = z.enum(['OUTBOUND', 'INBOUND'])
export type MessageDirection = z.infer<typeof MessageDirectionSchema>

/**
 * A categoria é o eixo que decide **três** coisas de uma vez: base legal, janela de
 * silêncio e teto diário. Ela vem do template e o chamador não pode elevá-la — do
 * contrário bastaria marcar uma campanha como transacional para furar o opt-out.
 *
 * - `TRANSACTIONAL` — execução de contrato: lembrete, confirmação, cobrança.
 * - `OPERATIONAL` — está acontecendo com o pet agora (taxi). **Ignora a janela.**
 * - `MARKETING` — exige consentimento: aniversário, campanha.
 */
export const MessageCategorySchema = z.enum(['TRANSACTIONAL', 'OPERATIONAL', 'MARKETING'])
export type MessageCategory = z.infer<typeof MessageCategorySchema>

export const MessageStatusSchema = z.enum([
  'QUEUED',
  'SCHEDULED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'DEAD',
  'BLOCKED',
  'CANCELLED',
  'MERGED',
])
export type MessageStatus = z.infer<typeof MessageStatusSchema>

/** Estados de onde a mensagem ainda pode sair — a fila propriamente dita. */
export const PENDING_MESSAGE_STATUSES = ['QUEUED', 'SCHEDULED'] as const

/** Estados terminais: não voltam sozinhos, e `DEAD` só volta por reenvio manual. */
export const TERMINAL_MESSAGE_STATUSES = [
  'DELIVERED',
  'READ',
  'DEAD',
  'BLOCKED',
  'CANCELLED',
] as const

export const MessageBlockReasonSchema = z.enum([
  'NO_CONSENT',
  'SUPPRESSED',
  'NO_CHANNEL',
  'PET_DECEASED',
  'QUIET_HOURS_EXPIRED',
])
export type MessageBlockReason = z.infer<typeof MessageBlockReasonSchema>

/**
 * O que invalida a mensagem enquanto ela espera na fila (AC-06 de MOD-CRM-03).
 * Sem o par origem/id, um agendamento cancelado às 20h ainda mandaria "seu banho é
 * amanhã" às 8h.
 */
export const MessageOriginTypeSchema = z.enum([
  'APPOINTMENT',
  'TAXI_RIDE',
  'LEDGER_ENTRY',
  'CAMPAIGN_RUN',
  'PET',
  'MANUAL',
])
export type MessageOriginType = z.infer<typeof MessageOriginTypeSchema>

export const SuppressionReasonSchema = z.enum([
  'HARD_BOUNCE',
  'NOT_ON_WHATSAPP',
  'ANONYMIZED',
  'MANUAL',
])
export type SuppressionReason = z.infer<typeof SuppressionReasonSchema>

export const MessageEventKindSchema = z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED'])
export type MessageEventKind = z.infer<typeof MessageEventKindSchema>

// ─── Limites por canal ───────────────────────────────────────────────────────

/**
 * WhatsApp corta em 4096; e-mail não tem limite real, mas 20 000 caracteres já é
 * muito mais do que qualquer template deste produto precisa, e o teto existe para
 * impedir que um corpo colado por engano vire um envio de megabytes.
 */
export const MESSAGE_BODY_LIMITS: Record<MessageChannel, number> = {
  WHATSAPP: 4096,
  EMAIL: 20_000,
}

// ─── Entrada do motor ────────────────────────────────────────────────────────

/**
 * A **única** porta de entrada do envio (§5 do PRD).
 *
 * Idempotente por `dedupeKey`: o broker entrega ao menos uma vez e um redeploy no
 * meio de um consumo reprocessa o evento — sem a chave, cada redeploy mandaria o
 * lembrete de novo.
 */
export const EnqueueMessageSchema = z.object({
  tutorId: z.uuid(),
  petId: z.uuid().optional(),
  templateKey: z.string().min(1).max(60),
  channel: MessageChannelPrefSchema.default('AUTO'),
  variables: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  dedupeKey: z.string().min(1).max(120),
  originType: MessageOriginTypeSchema.optional(),
  originId: z.uuid().optional(),
  /**
   * Nulo = assim que a janela permitir. Não existe "agora à força": a janela de
   * silêncio é do tutor, não do chamador.
   */
  scheduledFor: z.coerce.date().optional(),
  /**
   * Mensagem que perde o sentido se atrasar: o código de acesso ao Portal é o caso.
   *
   * Duas consequências, e as duas são exceções às regras do MOD-CRM: a mensagem **não**
   * é absorvida por uma irmã recente (RN-08 agruparia o código dentro de outro texto), e
   * o despacho acontece na mesma requisição, sem esperar o tique do worker. Um código de
   * dez minutos que sai no minuto sete não serve para nada.
   *
   * A janela de silêncio continua valendo pelo que a categoria do template disser — quem
   * precisa furá-la usa `OPERATIONAL`, e isso é decisão do texto, não de quem o dispara.
   */
  urgent: z.boolean().default(false),
  /**
   * Manda para **este** endereço, e não para o que está na ficha do tutor.
   *
   * Existe por um caso só, e é o que justifica a exceção: o MOD-PORTAL-09 precisa provar
   * que o tutor possui o telefone ou o e-mail **novo**, e um código enviado ao contato
   * antigo não prova nada. O endereço ainda não está gravado em lugar nenhum quando a
   * mensagem sai — se estivesse, a prova viria depois do fato que ela deveria autorizar.
   *
   * O que impede isto de virar "mandar mensagem para qualquer um": o serviço só o honra
   * com `channel` explícito e **nunca** para texto de categoria `MARKETING`. A lista de
   * supressão continua valendo, porque ela é do endereço e não da ficha — quem pediu
   * para não receber e-mail nosso não passa a receber por estar digitando o próprio
   * endereço numa tela nossa. O consentimento de marketing, esse, não se aplica: o que
   * atravessa aqui é execução de contrato, e o tutor acabou de pedir.
   */
  overrideAddress: z.string().min(3).max(160).optional(),
})
export type EnqueueMessageInput = z.output<typeof EnqueueMessageSchema>

export const MessageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: MessageStatusSchema.optional(),
  channel: MessageChannelSchema.optional(),
  category: MessageCategorySchema.optional(),
  tutorId: z.uuid().optional(),
  templateKey: z.string().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type MessageListQuery = z.output<typeof MessageListQuerySchema>

export const MessageStatsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type MessageStatsQuery = z.output<typeof MessageStatsQuerySchema>

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * Um template só é gravado quando o petshop **muda** o texto: os padrões vivem em
 * `messaging-seed.ts` e a listagem é a união dos dois.
 *
 * Diverge do §4 do PRD, que previa uma linha por template semeada no provisionamento.
 * O motivo é prático: assim os oito tenants que já existem ganham os textos sem
 * backfill, e acrescentar um template novo no código não exige migration de dados.
 * O efeito observável do AC-01 é o mesmo — abrir a tela e ver os textos prontos.
 */
export const UpsertMessageTemplateSchema = z.object({
  subject: z.string().max(160).optional(),
  body: z.string().min(1).max(20_000),
  active: z.boolean().default(true),
})
export type UpsertMessageTemplateInput = z.output<typeof UpsertMessageTemplateSchema>

export const PreviewTemplateSchema = z.object({
  channel: MessageChannelSchema,
  subject: z.string().max(160).optional(),
  body: z.string().min(1).max(20_000),
  templateKey: z.string().min(1).max(60),
})
export type PreviewTemplateInput = z.output<typeof PreviewTemplateSchema>

// ─── Configuração ────────────────────────────────────────────────────────────

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/

const messagingSettingsShape = {
  enabled: z.boolean(),
  /** Decisão 16: 08:00–20:00 no fuso do tenant, configurável. */
  quietStart: z.string().regex(TIME_OF_DAY).default('08:00'),
  quietEnd: z.string().regex(TIME_OF_DAY).default('20:00'),
  marketingWeekdaysOnly: z.boolean().default(true),
  dailyCap: z.number().int().min(0).max(10_000).default(500),
  perMinuteCap: z.number().int().min(1).max(60).default(20),
  defaultChannel: MessageChannelPrefSchema.default('AUTO'),
  retentionMonths: z.number().int().min(6).max(60).default(24),
  senderName: z.string().max(60).nullish(),
  replyToEmail: z.email().nullish(),
}

/**
 * A janela precisa terminar depois de começar. É o mesmo CHECK que existe no banco —
 * uma janela vazia deixaria o motor sem hora nenhuma para enviar, e a fila cresceria
 * em silêncio.
 */
const QUIET_WINDOW_MESSAGE =
  'A janela precisa terminar depois de começar — madrugada não é janela válida'

export const MessagingSettingsSchema = z
  .object(messagingSettingsShape)
  .refine((value) => value.quietEnd > value.quietStart, {
    message: QUIET_WINDOW_MESSAGE,
    path: ['quietEnd'],
  })
export type MessagingSettingsInput = z.output<typeof MessagingSettingsSchema>

/**
 * O PATCH parcial repete a checagem em vez de derivá-la com `.partial()`, que o Zod
 * recusa sobre schema com refinamento. A diferença de comportamento é intencional:
 * aqui a janela só é conferida quando **as duas pontas** vêm na mesma requisição —
 * mandar só `quietEnd` é válido, e quem valida o resultado final é o CHECK do banco.
 */
export const UpdateMessagingSettingsSchema = z
  .object(messagingSettingsShape)
  .partial()
  .refine(
    (value) =>
      value.quietStart === undefined || value.quietEnd === undefined
        ? true
        : value.quietEnd > value.quietStart,
    { message: QUIET_WINDOW_MESSAGE, path: ['quietEnd'] },
  )
export type UpdateMessagingSettingsInput = z.output<typeof UpdateMessagingSettingsSchema>

export const MESSAGING_SETTINGS_DEFAULTS = {
  enabled: false,
  quietStart: '08:00',
  quietEnd: '20:00',
  marketingWeekdaysOnly: true,
  dailyCap: 500,
  perMinuteCap: 20,
  defaultChannel: 'AUTO',
  retentionMonths: 24,
} as const

// ─── Automações ──────────────────────────────────────────────────────────────

/**
 * `config` por chave, validada por união discriminada — não um JSON solto. Uma
 * automação com `leadHours` num campo que ninguém lê é uma automação que o petshop
 * acha que configurou.
 *
 * **`strictObject`, e não `object`.** O `object` do Zod *descarta* chave desconhecida
 * em silêncio em vez de recusá-la, e era exatamente isso que acontecia: mandar
 * `leadHours` para `service_done` respondia 200, gravava o campo na `config` e marcava
 * a automação como personalizada — o petshop configurava uma antecedência que ninguém
 * jamais leria. É o defeito que este comentário dizia estar prevenindo.
 */
export const AutomationConfigSchema = z.discriminatedUnion('key', [
  z.strictObject({
    key: z.literal('appointment_reminder'),
    leadHours: z.number().int().min(1).max(168).default(24),
  }),
  z.strictObject({
    key: z.literal('appointment_confirmed'),
  }),
  z.strictObject({
    key: z.literal('appointment_cancelled'),
  }),
  z.strictObject({
    key: z.literal('service_done'),
  }),
  // As do Taxi Dog não têm parâmetro: o disparo é o evento da corrida, e não há nada a
  // afinar. Continuam na união porque `z.strictObject` é o que recusa uma `config` que
  // o petshop acha que configurou — mandar `leadHours` para "chegamos" gravaria um
  // campo que ninguém lê.
  z.strictObject({
    key: z.literal('taxi_en_route'),
  }),
  z.strictObject({
    key: z.literal('taxi_arrived'),
  }),
  z.strictObject({
    key: z.literal('taxi_delivered'),
  }),
  z.strictObject({
    key: z.literal('taxi_failed'),
  }),
])
export type AutomationConfig = z.output<typeof AutomationConfigSchema>

export const AUTOMATION_KEYS = [
  'appointment_reminder',
  'appointment_confirmed',
  'appointment_cancelled',
  'service_done',
  'taxi_en_route',
  'taxi_arrived',
  'taxi_delivered',
  'taxi_failed',
] as const

/**
 * As que só fazem sentido com o Taxi Dog ligado (AC-04 de MOD-CRM-09).
 *
 * `listAutomations` as omite quando `taxi_settings.enabled` é falso. Configuração de um
 * módulo desligado é ruído: quatro interruptores que não fazem nada, no meio dos que
 * fazem, ensinam o admin a não confiar na tela.
 */
export const TAXI_AUTOMATION_KEYS = [
  'taxi_en_route',
  'taxi_arrived',
  'taxi_delivered',
  'taxi_failed',
] as const
export type AutomationKey = (typeof AUTOMATION_KEYS)[number]

export const UpdateAutomationSchema = z.object({
  enabled: z.boolean().optional(),
  channel: MessageChannelPrefSchema.optional(),
  templateKey: z.string().min(1).max(60).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateAutomationInput = z.output<typeof UpdateAutomationSchema>

// ─── Supressões ──────────────────────────────────────────────────────────────

export const CreateSuppressionSchema = z.object({
  channel: MessageChannelSchema,
  /** Telefone em E.164 ou e-mail; guardado só como hash (§9 do PRD). */
  address: z.string().min(3).max(160),
  reason: SuppressionReasonSchema.default('MANUAL'),
})
export type CreateSuppressionInput = z.output<typeof CreateSuppressionSchema>

// ─── Respostas ───────────────────────────────────────────────────────────────

export const MessageSummarySchema = z.object({
  id: z.uuid(),
  tutorId: z.uuid(),
  /**
   * Nome de exibição do destinatário, resolvido na leitura.
   *
   * Vai no resumo, e não é composto pela tela, porque o painel lista vinte linhas de
   * vinte tutores diferentes: buscar cada nome por HTTP seria vinte idas ao gateway
   * para escrever vinte palavras. `messages` já tem a relação com `tutors` e
   * `full_name` está em claro — é uma consulta a mais por página, não por linha.
   * Mesmo caminho que o painel do Taxi Dog já usa.
   */
  tutorName: z.string(),
  petId: z.uuid().nullable(),
  channel: MessageChannelSchema,
  direction: MessageDirectionSchema,
  category: MessageCategorySchema,
  templateKey: z.string(),
  status: MessageStatusSchema,
  blockReason: MessageBlockReasonSchema.nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  scheduledFor: z.iso.datetime().nullable(),
  sentAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  readAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  errorDetail: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type MessageSummary = z.infer<typeof MessageSummarySchema>

export const PaginatedMessagesSchema = z.object({
  data: z.array(MessageSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
})
export type PaginatedMessages = z.infer<typeof PaginatedMessagesSchema>

export const MessageStatsSchema = z.object({
  queued: z.number().int(),
  scheduled: z.number().int(),
  sent: z.number().int(),
  delivered: z.number().int(),
  failed: z.number().int(),
  dead: z.number().int(),
  blocked: z.number().int(),
  cancelled: z.number().int(),
  /** RN-08: absorvidas por outra mensagem. Saíram — só não sozinhas. */
  merged: z.number().int(),
  /** Por motivo — bloqueio alto por falta de consentimento é problema de cadastro. */
  blockedByReason: z.record(z.string(), z.number().int()),
  /** Idade, em segundos, da mensagem mais velha ainda na fila (AC-03 de MOD-CRM-11). */
  oldestPendingSeconds: z.number().int().nullable(),
})
export type MessageStats = z.infer<typeof MessageStatsSchema>

/**
 * Um texto como a tela o recebe: o padrão do catálogo, ou o override do tenant por
 * cima dele. `isDefault` é o que decide se cabe oferecer "voltar ao texto padrão" —
 * o de fábrica não tem a que voltar.
 */
export const ResolvedTemplateSchema = z.object({
  key: z.string(),
  channel: MessageChannelSchema,
  category: MessageCategorySchema,
  subject: z.string().nullable(),
  body: z.string(),
  active: z.boolean(),
  /** Zero é o texto de fábrica; cada gravação incrementa. */
  version: z.number().int(),
  isDefault: z.boolean(),
  variables: z.array(z.string()),
})
export type ResolvedTemplate = z.infer<typeof ResolvedTemplateSchema>

/** `missing` são as marcações que a prévia não soube preencher — buracos na frase. */
export const TemplatePreviewSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  missing: z.array(z.string()),
})
export type TemplatePreview = z.infer<typeof TemplatePreviewSchema>

/** O que `GET /v1/messaging/settings` devolve: a configuração mais o fuso do petshop. */
export const MessagingSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  quietStart: z.string(),
  quietEnd: z.string(),
  marketingWeekdaysOnly: z.boolean(),
  dailyCap: z.number().int(),
  perMinuteCap: z.number().int(),
  defaultChannel: MessageChannelPrefSchema,
  retentionMonths: z.number().int(),
  senderName: z.string().nullable(),
  replyToEmail: z.string().nullable(),
  /** De `tenant_settings`, não daqui: o fuso é do estabelecimento. */
  timezone: z.string(),
})
export type MessagingSettingsResponse = z.infer<typeof MessagingSettingsResponseSchema>

/**
 * Uma supressão como a tela pode vê-la.
 *
 * **Sem o endereço**, e não por esquecimento: o banco guarda só o hash (AC-05 de
 * MOD-CRM-04). A lista de quem pediu para parar não pode ser, ela mesma, uma lista de
 * contatos exportável — então a tela mostra canal, motivo e data, e quem procura um
 * endereço específico o digita para removê-lo.
 */
export const SuppressionResponseSchema = z.object({
  id: z.uuid(),
  channel: MessageChannelSchema,
  reason: SuppressionReasonSchema,
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type SuppressionResponse = z.infer<typeof SuppressionResponseSchema>

/** Uma automação resolvida: o padrão do código, ou o que o petshop mudou por cima. */
export const AutomationResponseSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  channel: MessageChannelPrefSchema,
  templateKey: z.string(),
  config: z.record(z.string(), z.unknown()),
  isDefault: z.boolean(),
  label: z.string(),
  description: z.string(),
})
export type AutomationResponse = z.infer<typeof AutomationResponseSchema>

// ─── Rótulos de tela ─────────────────────────────────────────────────────────

/**
 * Os nomes que o painel mostra.
 *
 * Ficam aqui, e não na tela, porque o histórico na ficha do tutor e o painel de
 * entregas mostram os mesmos estados — e duas listas divergem no dia em que alguém
 * traduzir `DEAD` como "morta" num lugar e "desistimos" no outro.
 */
export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  QUEUED: 'Na fila',
  SCHEDULED: 'Agendada',
  SENDING: 'Enviando',
  SENT: 'Enviada',
  DELIVERED: 'Entregue',
  READ: 'Lida',
  FAILED: 'Falhou',
  DEAD: 'Desistimos',
  BLOCKED: 'Bloqueada',
  CANCELLED: 'Cancelada',
  // Não é "não enviada": o texto dela saiu, dentro da mensagem que a absorveu.
  MERGED: 'Agrupada',
}

export const MESSAGE_CHANNEL_LABELS: Record<MessageChannel, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
}

export const MESSAGE_CATEGORY_LABELS: Record<MessageCategory, string> = {
  TRANSACTIONAL: 'Transacional',
  OPERATIONAL: 'Operacional',
  MARKETING: 'Marketing',
}

/**
 * O motivo do bloqueio, escrito como causa e não como código.
 *
 * É o texto que decide se o admin conserta a coisa certa: `NO_CONSENT` manda para o
 * cadastro do tutor, `NO_CHANNEL` para o telefone, e confundi-los custa uma tarde.
 */
export const MESSAGE_BLOCK_REASON_LABELS: Record<MessageBlockReason, string> = {
  NO_CONSENT: 'Sem consentimento do tutor',
  SUPPRESSED: 'Endereço na lista de supressão',
  NO_CHANNEL: 'Tutor sem telefone ou e-mail utilizável',
  PET_DECEASED: 'Pet falecido',
  QUIET_HOURS_EXPIRED: 'A janela de envio passou antes de a mensagem sair',
}

/**
 * A fila represada (AC-03 de MOD-CRM-11).
 *
 * O mesmo par de números que `checkQueueHealth` usa para gritar no log. Ficam
 * compartilhados de propósito: se o job alerta com 200 há 30 minutos e o painel
 * avisasse com outro número, o admin veria a faixa sumir sem nada ter melhorado — ou
 * pior, não a veria enquanto o alerta dispara.
 */
export const MESSAGE_QUEUE_STUCK_COUNT = 200
export const MESSAGE_QUEUE_STUCK_SECONDS = 30 * 60

export const SUPPRESSION_REASON_LABELS: Record<SuppressionReason, string> = {
  HARD_BOUNCE: 'Endereço inexistente',
  NOT_ON_WHATSAPP: 'Número não tem WhatsApp',
  ANONYMIZED: 'Cadastro anonimizado',
  MANUAL: 'Bloqueado à mão',
}

export const MESSAGE_CHANNEL_PREF_LABELS: Record<MessageChannelPref, string> = {
  AUTO: 'Automático',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
}

// ─── A conexão do WhatsApp (MOD-CRM-01) ──────────────────────────────────────

export const WhatsappInstanceStatusSchema = z.enum([
  'NOT_CONFIGURED',
  'CONNECTING',
  'CONNECTED',
  'DISCONNECTED',
  'BANNED',
])
export type WhatsappInstanceStatus = z.infer<typeof WhatsappInstanceStatusSchema>

/**
 * O estado da conexão como a tela o recebe.
 *
 * **Sem a chave da instância e sem o token do webhook**, nem cifrados: são credenciais
 * do provedor, e o navegador não tem o que fazer com elas. O que a tela precisa é
 * decidir entre quatro desenhos — não configurado, QR na mão, conectado, quebrado.
 *
 * `qrCode` só vem em `CONNECTING`, é um data URI e **não** é guardado: expira em
 * segundos do lado da Evolution, e um QR velho na tela é pior que nenhum, porque a
 * pessoa fica tentando escanear.
 */
export const WhatsappConnectionSchema = z.object({
  status: WhatsappInstanceStatusSchema,
  phone: z.string().nullable(),
  connectedAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  /** `data:image/png;base64,…`, só enquanto `CONNECTING`. */
  qrCode: z.string().nullable(),
  /** O que o provedor disse ao cair ou bloquear — a faixa vermelha precisa de motivo. */
  lastError: z.string().nullable(),
  /**
   * RN-06: quantos dias ainda faltam do aquecimento, ou `null` fora dele. A tela avisa
   * que o teto está reduzido de propósito — senão o admin lê "só saíram 30" como falha.
   */
  warmupDaysLeft: z.number().int().nullable(),
  /** O teto que vale **hoje**, já com o aquecimento aplicado. */
  effectiveDailyCap: z.number().int(),
})
export type WhatsappConnection = z.infer<typeof WhatsappConnectionSchema>

export const WHATSAPP_STATUS_LABELS: Record<WhatsappInstanceStatus, string> = {
  NOT_CONFIGURED: 'Não conectado',
  CONNECTING: 'Aguardando leitura do QR',
  CONNECTED: 'Conectado',
  DISCONNECTED: 'Desconectado',
  BANNED: 'Número bloqueado',
}

/**
 * RN-06 — o aquecimento do número.
 *
 * Nos primeiros dias após o pareamento o teto diário é `min(dailyCap, 30 × dias)`.
 * Vive aqui, e não no messaging-service, porque a **tela** precisa da mesma conta para
 * dizer ao admin quanto pode sair hoje — duas implementações da mesma regra divergem
 * no dia em que uma delas mudar.
 */
export const WHATSAPP_WARMUP_DAYS = 7
export const WHATSAPP_WARMUP_DAILY_STEP = 30

/** Dia 1 do aquecimento vale 30; o dia 8 em diante devolve o teto cheio. */
export function whatsappWarmupCap(
  dailyCap: number,
  warmupStartedAt: Date | null | undefined,
  now: Date = new Date(),
): { cap: number; daysLeft: number | null } {
  if (!warmupStartedAt) return { cap: dailyCap, daysLeft: null }

  const elapsedMs = now.getTime() - warmupStartedAt.getTime()
  const dayIndex = Math.floor(elapsedMs / 86_400_000) + 1
  if (dayIndex > WHATSAPP_WARMUP_DAYS) return { cap: dailyCap, daysLeft: null }

  // Relógio adiantado, ou uma data futura gravada à mão: trata-se como o primeiro dia,
  // que é o lado seguro — nunca conceder teto cheio por causa de um erro de data.
  const day = Math.max(1, dayIndex)
  return {
    cap: Math.min(dailyCap, day * WHATSAPP_WARMUP_DAILY_STEP),
    daysLeft: WHATSAPP_WARMUP_DAYS - day + 1,
  }
}
