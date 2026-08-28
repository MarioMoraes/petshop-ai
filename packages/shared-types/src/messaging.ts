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
 */
export const AutomationConfigSchema = z.discriminatedUnion('key', [
  z.object({
    key: z.literal('appointment_reminder'),
    leadHours: z.number().int().min(1).max(168).default(24),
  }),
  z.object({
    key: z.literal('appointment_confirmed'),
  }),
  z.object({
    key: z.literal('appointment_cancelled'),
  }),
  z.object({
    key: z.literal('service_done'),
  }),
])
export type AutomationConfig = z.output<typeof AutomationConfigSchema>

export const AUTOMATION_KEYS = [
  'appointment_reminder',
  'appointment_confirmed',
  'appointment_cancelled',
  'service_done',
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

export const MessageStatsSchema = z.object({
  queued: z.number().int(),
  scheduled: z.number().int(),
  sent: z.number().int(),
  delivered: z.number().int(),
  failed: z.number().int(),
  dead: z.number().int(),
  blocked: z.number().int(),
  cancelled: z.number().int(),
  /** Por motivo — bloqueio alto por falta de consentimento é problema de cadastro. */
  blockedByReason: z.record(z.string(), z.number().int()),
  /** Idade, em segundos, da mensagem mais velha ainda na fila (AC-03 de MOD-CRM-11). */
  oldestPendingSeconds: z.number().int().nullable(),
})
export type MessageStats = z.infer<typeof MessageStatsSchema>
