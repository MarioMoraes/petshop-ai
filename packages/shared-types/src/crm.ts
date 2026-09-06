import { z } from 'zod'

/**
 * Campanhas (MOD-CRM-07 e MOD-CRM-12, fatia 3 do PRD relacionamento_crm_08).
 *
 * Uma campanha é **quem receber**, não **o que enviar**: o texto continua vindo do
 * catálogo de `messaging-seed.ts`, e o que a campanha acrescenta é o segmento, o
 * agendamento e a prestação de contas — quantos entraram, quantos saíram e por quê.
 *
 * A distinção que organiza o arquivo inteiro: `segment` é um **filtro reproduzível**,
 * guardado como JSON, e nunca uma lista congelada de tutores. Uma lista montada na
 * segunda e disparada na quinta convida de volta quem voltou na terça (AC-03 de
 * MOD-CRM-07) e cobra quem pagou ontem. O segmento é resolvido no instante da execução,
 * sempre.
 */

export const CampaignTypeSchema = z.enum([
  /** Reativação por inatividade — criada e executada pelo job (MOD-CRM-07). */
  'INACTIVE',
  /** Aniversário. Reservada: hoje o disparo é automação pura, sem run. */
  'BIRTHDAY',
  /** Régua de cobrança. Reservada pelo mesmo motivo. */
  'DUNNING',
  /** Montada à mão por alguém com `crm:send` (MOD-CRM-12). */
  'MANUAL',
])
export type CampaignType = z.infer<typeof CampaignTypeSchema>

export const CampaignStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'DONE',
  'CANCELLED',
  'FAILED',
])
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>

export const CampaignTargetStatusSchema = z.enum(['SENT', 'SKIPPED', 'FAILED'])
export type CampaignTargetStatus = z.infer<typeof CampaignTargetStatusSchema>

/**
 * Por que aquela pessoa não recebeu.
 *
 * É a coluna que dá sentido à prévia: um segmento de 340 que envia 300 precisa
 * responder pelos 40, e "40 pulados" sem motivo é a mesma coisa que nada. Os motivos
 * não se sobrepõem aos de `MessageBlockReason` por acaso — os que existem nos dois são
 * o mesmo fato visto de lados diferentes, e a campanha registra o dela **antes** de
 * pedir o enfileiramento, para não criar mensagem que já se sabe que não sai.
 */
export const CampaignSkipReasonSchema = z.enum([
  'NO_CONSENT',
  /** AC-02 de MOD-CRM-07: recebeu esta campanha dentro da carência. */
  'ALREADY_TARGETED',
  /** AC-05 de MOD-CRM-07: oferta de volta para quem deve é convite errado. */
  'HAS_DEBT',
  'PET_DECEASED',
  'NO_CHANNEL',
  'SUPPRESSED',
  /** O teto semanal de marketing do tutor. */
  'WEEKLY_CAP',
  /** O motor recusou o enfileiramento (mensagens desligadas, texto inexistente). */
  'ENQUEUE_FAILED',
])
export type CampaignSkipReason = z.infer<typeof CampaignSkipReasonSchema>

export const CAMPAIGN_SKIP_REASON_LABELS: Record<CampaignSkipReason, string> = {
  NO_CONSENT: 'Sem consentimento de marketing',
  ALREADY_TARGETED: 'Já recebeu esta campanha há pouco tempo',
  HAS_DEBT: 'Tem valor em aberto',
  PET_DECEASED: 'Pet falecido',
  NO_CHANNEL: 'Sem telefone ou e-mail utilizável',
  SUPPRESSED: 'Endereço na lista de supressão',
  WEEKLY_CAP: 'Já recebeu a mensagem de marketing da semana',
  ENQUEUE_FAILED: 'O motor de mensagens recusou o envio',
}

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: 'Rascunho',
  SCHEDULED: 'Agendada',
  RUNNING: 'Em execução',
  DONE: 'Concluída',
  CANCELLED: 'Cancelada',
  FAILED: 'Falhou',
}

export const CAMPAIGN_TYPE_LABELS: Record<CampaignType, string> = {
  INACTIVE: 'Reativação de inativos',
  BIRTHDAY: 'Aniversário',
  DUNNING: 'Cobrança',
  MANUAL: 'Campanha manual',
}

/**
 * O filtro, guardado como JSON e resolvido na execução.
 *
 * Todo campo é opcional e todo campo **restringe**: um segmento vazio é "todo tutor
 * ativo do estabelecimento", que é exatamente o disparo em massa que a confirmação de
 * contagem (AC-02 de MOD-CRM-12) existe para proteger. Deixá-lo representável é
 * deliberado — há campanha que é para todo mundo mesmo, e proibi-la no schema só faria
 * o admin escolher todas as tags para conseguir o mesmo efeito.
 */
export const CampaignSegmentSchema = z.strictObject({
  /** Chaves de `tutor_tags`; o tutor precisa ter **ao menos uma**. */
  tagKeys: z.array(z.string().min(1).max(40)).max(20).optional(),
  /** Sem atendimento há pelo menos tantos dias. */
  inactiveDaysMin: z.number().int().min(0).max(3650).optional(),
  /** Com atendimento nos últimos tantos dias — o oposto do anterior. */
  activeDaysMax: z.number().int().min(1).max(3650).optional(),
  /** Tutores com pet de alguma destas espécies. */
  speciesIds: z.array(z.uuid()).max(20).optional(),
  /** Tutores com pet de algum destes portes. */
  sizeIds: z.array(z.uuid()).max(20).optional(),
  /**
   * Deixar de fora quem tem saldo devedor. Padrão **true** em campanha de marketing:
   * a mesma regra do AC-05 de MOD-CRM-07, e pela mesma razão — quem deve é assunto da
   * régua de cobrança, não de oferta.
   */
  excludeDebtors: z.boolean().default(true),
  /**
   * Exigir ao menos um pet vivo. Padrão **true**.
   *
   * Um convite de volta para quem enterrou o único cachorro é a mesma crueldade do
   * AC-02 de MOD-CRM-06 por outra porta, e "faz tempo que não aparece" é exatamente o
   * que se diz de quem perdeu o pet. Quem quiser falar com a base inteira desliga a
   * caixa — mas é uma decisão que alguém precisa tomar de propósito.
   */
  requiresActivePet: z.boolean().default(true),
})
export type CampaignSegment = z.output<typeof CampaignSegmentSchema>

const campaignShape = {
  name: z.string().min(1).max(120),
  templateKey: z.string().min(1).max(60),
  channel: z.enum(['AUTO', 'WHATSAPP', 'EMAIL']).default('AUTO'),
  segment: CampaignSegmentSchema.default({ excludeDebtors: true, requiresActivePet: true }),
  /** Nulo dispara na hora em que alguém clicar; com data, o job pega. */
  scheduledFor: z.iso.datetime({ offset: true }).nullish(),
}

export const CreateCampaignSchema = z.strictObject(campaignShape)
export type CreateCampaignInput = z.output<typeof CreateCampaignSchema>

/**
 * O PATCH repete o shape em vez de derivá-lo com `.partial()`.
 *
 * `.partial()` **não remove `.default()`** — foi o defeito do MOD-IDENT-08, que gravava
 * padrões por cima do que o tenant havia customizado. Aqui morderia em `segment` e em
 * `channel`: um PATCH só de `name` reescreveria o segmento inteiro com o padrão.
 */
export const UpdateCampaignSchema = z.strictObject({
  name: campaignShape.name.optional(),
  templateKey: campaignShape.templateKey.optional(),
  channel: z.enum(['AUTO', 'WHATSAPP', 'EMAIL']).optional(),
  segment: CampaignSegmentSchema.optional(),
  scheduledFor: z.iso.datetime({ offset: true }).nullish(),
})
export type UpdateCampaignInput = z.output<typeof UpdateCampaignSchema>

/**
 * A confirmação de contagem (AC-02 de MOD-CRM-12).
 *
 * `expectedTargets` é o número que a pessoa **viu** na prévia. Divergiu, 409: o
 * segmento mudou entre olhar e disparar, e mandar assim mesmo é como confirmar uma
 * transferência para uma conta que trocou de dono no meio do caminho.
 */
export const RunCampaignSchema = z.strictObject({
  expectedTargets: z.number().int().min(0).max(100_000),
})
export type RunCampaignInput = z.output<typeof RunCampaignSchema>

/** O que a prévia devolve, e o que o disparo precisa reproduzir dígito a dígito. */
export const CampaignPreviewSchema = z.object({
  targeted: z.number().int(),
  eligible: z.number().int(),
  skipped: z.number().int(),
  /** Motivo → quantos. Só os que aconteceram. */
  skippedByReason: z.record(CampaignSkipReasonSchema, z.number().int()),
  /** Uma amostra de nomes, para a pessoa reconhecer que o filtro faz o que ela quer. */
  sample: z.array(z.object({ tutorId: z.uuid(), name: z.string() })).max(10),
})
export type CampaignPreview = z.infer<typeof CampaignPreviewSchema>

export const CampaignRunSummarySchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  targeted: z.number().int(),
  sent: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
})
export type CampaignRunSummary = z.infer<typeof CampaignRunSummarySchema>

export const CampaignSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: CampaignTypeSchema,
  status: CampaignStatusSchema,
  templateKey: z.string(),
  templateLabel: z.string(),
  channel: z.enum(['AUTO', 'WHATSAPP', 'EMAIL']),
  segment: CampaignSegmentSchema,
  scheduledFor: z.string().nullable(),
  createdAt: z.string(),
  lastRun: CampaignRunSummarySchema.nullable(),
})
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>

export const CampaignTargetRowSchema = z.object({
  id: z.uuid(),
  tutorId: z.uuid(),
  tutorName: z.string(),
  status: CampaignTargetStatusSchema,
  skipReason: CampaignSkipReasonSchema.nullable(),
  messageId: z.uuid().nullable(),
  createdAt: z.string(),
})
export type CampaignTargetRow = z.infer<typeof CampaignTargetRowSchema>

/**
 * Os textos que uma campanha manual pode usar.
 *
 * Só os de `MARKETING`, e nem todos: os de aniversário falam de uma data que só o job
 * conhece, e disparar "hoje é aniversário do Rex" para trezentas pessoas em março é o
 * tipo de erro que um seletor honesto não deveria permitir cometer.
 */
export const CAMPAIGN_TEMPLATE_KEYS = ['campaign_broadcast', 'winback'] as const

/**
 * O nome da campanha de sistema que o job de inativos usa.
 *
 * `campaign_runs` exige uma campanha, e a reativação não é montada por ninguém — ela
 * nasce da automação. A linha é criada na primeira execução do tenant e reaproveitada
 * em todas as seguintes, para que o histórico de runs tenha onde morar.
 */
export const INACTIVE_CAMPAIGN_NAME = 'Reativação de inativos'
