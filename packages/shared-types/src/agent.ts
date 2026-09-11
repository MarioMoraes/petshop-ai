import { z } from 'zod'

/**
 * MOD-AI — a conversa que chega pelo WhatsApp (PRD agentes_ia_15 §4 e §5).
 *
 * O §1 do PRD abre com a descoberta que dimensionou a fase: `MessageDirection` declarava
 * `INBOUND` desde o MOD-NOTIF, três arquivos o tipavam, e **nenhuma linha do sistema
 * escrevia uma**. O webhook da Evolution tratava `QRCODE_*` e `CONNECTION_*` e descartava
 * o resto — o canal só sabia falar.
 *
 * O módulo tem duas metades, e a primeira não depende da segunda:
 *
 * - **a porta de entrada** (fatia 1): a mensagem vira linha, a linha vira conversa, e a
 *   conversa vira fila da recepção. É o que sobra quando o agente está desligado, e o
 *   AC-02 de MOD-AI-07 diz que esse é um estado permanente e legítimo — uma recepção que
 *   responde WhatsApp dentro do sistema já é produto;
 * - **o agente** (fatia 2): as sete tools de leitura, o provedor atrás de porta, o teto
 *   de gasto e as saídas para handoff. Tudo o que ele não resolve volta para a fila.
 */

export const AGENT_CONVERSATION_STATUSES = ['ACTIVE', 'HANDOFF', 'ASSIGNED', 'CLOSED'] as const
export const AgentConversationStatusSchema = z.enum(AGENT_CONVERSATION_STATUSES)
export type AgentConversationStatus = z.infer<typeof AgentConversationStatusSchema>

/**
 * Por que a conversa está na mão de gente.
 *
 * **Os seis primeiros são os do §6 do PRD; os quatro últimos não estão lá**, e a razão é
 * que o §6 desenha a máquina do agente respondendo — pedido, sentimento, impasse, teto,
 * erro. Nesta fatia o agente não existe, e todo caminho termina na recepção: sem um
 * motivo que diga **qual** caminho foi, a fila mostraria dez conversas idênticas e a
 * recepção abriria uma por uma para descobrir que três são do mesmo número desconhecido.
 *
 * `AMBIGUOUS` é o AC-03 de MOD-AI-01 e repete a decisão do AC-06 de MOD-PORTAL-01: dois
 * tutores com o mesmo telefone (marido e esposa, que o MOD-TUTOR permite) não se
 * desempatam sozinhos, porque escolher um daria a ele a conversa do outro.
 */
export const AGENT_HANDOFF_REASONS = [
  'REQUESTED',
  'SENTIMENT',
  'UNRESOLVED',
  'TOO_LONG',
  'BUDGET',
  'ERROR',
  /** O agente está desligado, fora da janela, ou ainda não existe. */
  'DISABLED',
  /** Número sem ficha neste estabelecimento (AC-02 de MOD-AI-01). */
  'UNKNOWN_NUMBER',
  /** O mesmo telefone em duas fichas (AC-03 de MOD-AI-01). */
  'AMBIGUOUS',
  /** Áudio, imagem ou documento (AC-05 de MOD-AI-01). */
  'MEDIA',
] as const
export const AgentHandoffReasonSchema = z.enum(AGENT_HANDOFF_REASONS)
export type AgentHandoffReason = z.infer<typeof AgentHandoffReasonSchema>

export const AGENT_HANDOFF_LABELS: Record<AgentHandoffReason, string> = {
  REQUESTED: 'O cliente pediu para falar com alguém',
  SENTIMENT: 'O cliente parece insatisfeito',
  UNRESOLVED: 'A conversa não andou',
  TOO_LONG: 'A conversa ficou longa demais',
  BUDGET: 'O limite de custo do mês foi atingido',
  ERROR: 'Houve uma falha no atendimento automático',
  DISABLED: 'O atendimento automático está desligado',
  UNKNOWN_NUMBER: 'Número sem cadastro',
  AMBIGUOUS: 'O número está em mais de uma ficha',
  MEDIA: 'O cliente mandou áudio, imagem ou arquivo',
}

/** Quem falou no turno. `AGENT` só aparece quando o modelo entrar, na fatia seguinte. */
export const AGENT_TURN_ROLES = ['TUTOR', 'AGENT', 'STAFF'] as const
export const AgentTurnRoleSchema = z.enum(AGENT_TURN_ROLES)
export type AgentTurnRole = z.infer<typeof AgentTurnRoleSchema>

export const AGENT_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const
export const AgentSentimentSchema = z.enum(AGENT_SENTIMENTS)
export type AgentSentiment = z.infer<typeof AgentSentimentSchema>

/**
 * O tipo do que chegou. `TEXT` é o único que o agente vai saber ler.
 *
 * O AC-05 de MOD-AI-01 é explícito: a linha guarda **o tipo e não o conteúdo**. Áudio
 * não se transcreve aqui — transcrição é da triagem clínica, que é outro agente e outra
 * fase.
 */
export const AGENT_INBOUND_KINDS = ['TEXT', 'AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT', 'OTHER'] as const
export const AgentInboundKindSchema = z.enum(AGENT_INBOUND_KINDS)
export type AgentInboundKind = z.infer<typeof AgentInboundKindSchema>

export const AGENT_INBOUND_LABELS: Record<AgentInboundKind, string> = {
  TEXT: 'mensagem',
  AUDIO: 'áudio',
  IMAGE: 'imagem',
  VIDEO: 'vídeo',
  DOCUMENT: 'arquivo',
  OTHER: 'mensagem não suportada',
}

/**
 * Quanto tempo uma conversa sobrevive calada (AC-02 de MOD-AI-02).
 *
 * Duas horas: depois disso, "sim" não se refere mais a coisa nenhuma. Vale para a
 * conversa que o agente conduzia; a que já está com a recepção **não expira sozinha**,
 * porque lá existe gente devendo resposta, e uma fila que se esvazia sozinha é uma fila
 * que esconde trabalho não feito.
 */
export const AGENT_SESSION_TTL_MIN = 120

/** Depois disso, a conversa parada na fila entra no sino (AC-04 de MOD-AI-06). */
export const AGENT_SLA_MIN = 10

/** O teto do que a recepção escreve numa resposta. O WhatsApp aceita mais; a tela, não. */
export const AGENT_REPLY_MAX = 1200

export const AgentConversationListQuerySchema = z.object({
  status: AgentConversationStatusSchema.optional(),
  /**
   * Só o que espera há mais de N minutos — o recorte do sino.
   *
   * Existe como filtro do servidor, e não como conta na tela, porque quem o usa é o
   * contador da topbar: ele precisa do **total**, e somar a partir de uma página seria
   * o mesmo erro que o `take: 200` do gráfico do painel já ensinou.
   */
  waitingOverMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type AgentConversationListQuery = z.output<typeof AgentConversationListQuerySchema>

export const AgentReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(AGENT_REPLY_MAX),
})
export type AgentReplyInput = z.output<typeof AgentReplySchema>

/** Uma ficha que casa com o telefone da conversa, quando ele não resolveu sozinho. */
export const AgentCandidateSchema = z.object({
  tutorId: z.uuid(),
  name: z.string(),
})
export type AgentCandidate = z.infer<typeof AgentCandidateSchema>

export const AgentConversationSummarySchema = z.object({
  id: z.uuid(),
  tutorId: z.uuid().nullable(),
  tutorName: z.string().nullable(),
  /**
   * O telefone de quem escreveu — **mascarado quando há ficha, inteiro quando não há**.
   *
   * Com ficha, o número completo está a um clique na tela do tutor, e repeti-lo na fila
   * seria espalhar contato por mais uma tela. Sem ficha, não existe outro lugar de onde
   * tirá-lo, e a recepção precisa dele justamente para ligar de volta para quem o
   * produto ainda não conhece.
   */
  contact: z.string(),
  status: AgentConversationStatusSchema,
  handoffReason: AgentHandoffReasonSchema.nullable(),
  assignedTo: z.uuid().nullable(),
  assignedToName: z.string().nullable(),
  turnCount: z.number().int(),
  lastTurnAt: z.iso.datetime(),
  /** Há quanto tempo espera. Do servidor, para a lista não depender do relógio do navegador. */
  waitingMinutes: z.number().int(),
  /** A última linha da conversa, para a fila dizer do que se trata sem abrir. */
  lastMessage: z.string(),
  createdAt: z.iso.datetime(),
})
export type AgentConversationSummary = z.infer<typeof AgentConversationSummarySchema>

export const AgentTurnViewSchema = z.object({
  id: z.uuid(),
  role: AgentTurnRoleSchema,
  content: z.string(),
  kind: AgentInboundKindSchema,
  sentiment: AgentSentimentSchema.nullable(),
  /** Quem escreveu, quando foi gente da equipe. */
  authorName: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type AgentTurnView = z.infer<typeof AgentTurnViewSchema>

export const AgentConversationDetailSchema = AgentConversationSummarySchema.extend({
  turns: z.array(AgentTurnViewSchema),
  /**
   * As fichas que casam com o telefone, quando a conversa não tem dono.
   *
   * Uma, quando o cadastro nasceu depois da mensagem; duas ou mais, quando é o caso do
   * AC-03; nenhuma, quando quem escreveu não é cliente. A lista é resolvida **na
   * leitura**, e não gravada na conversa: o tutor cadastrado hoje precisa aparecer na
   * conversa de ontem.
   */
  candidates: z.array(AgentCandidateSchema),
  /** Só existe resposta pela tela quando há ficha — ver `replyBlockedReason`. */
  canReply: z.boolean(),
  replyBlockedReason: z.string().nullable(),
})
export type AgentConversationDetail = z.infer<typeof AgentConversationDetailSchema>

export const PaginatedAgentConversationsSchema = z.object({
  data: z.array(AgentConversationSummarySchema),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
})
export type PaginatedAgentConversations = z.infer<typeof PaginatedAgentConversationsSchema>

// ─── O agente (fatia 2) ──────────────────────────────────────────────────────

/**
 * O teto de turnos de uma conversa (AC-03 de MOD-AI-02).
 *
 * Vinte turnos sem resolver é o próprio sinal de que o agente não vai resolver: a
 * conversa vai para gente com motivo `TOO_LONG`.
 */
export const AGENT_MAX_TURNS = 20

/** Quantos turnos do histórico entram no prompt. Acima disso, os mais recentes. */
export const AGENT_HISTORY_TURNS = 12

/**
 * O teto de gasto de **uma** conversa, em milésimos de centavo (AC-01 de MOD-AI-08).
 *
 * Cinquenta centavos. Uma conversa que passa disso ou virou laço de tool, ou é longa
 * demais para o que o módulo se propõe — nos dois casos a recepção resolve mais barato.
 */
export const AGENT_MAX_CONVERSATION_MILLICENTS = 50_000

/**
 * **O tutor precisa saber que fala com um robô** (§9 do PRD).
 *
 * Vai na primeira resposta de toda conversa e **não é configurável pelo tenant**: é
 * requisito de transparência, não texto de marketing. Um petshop que pudesse editá-lo
 * acabaria apagando-o.
 */
export const AGENT_DISCLOSURE =
  'Oi! Sou o atendimento automático do {{petshop}}. ' +
  'Posso consultar horários, agendamentos e a situação da sua conta — ' +
  'e chamo alguém da equipe quando você precisar.'

/** A resposta que sai fora do horário do agente (AC-03 de MOD-AI-07). */
export const AGENT_OUT_OF_HOURS =
  'Oi! Recebemos sua mensagem. Nosso atendimento responde das {{abre}} às {{fecha}} — ' +
  'assim que abrirmos, alguém te responde por aqui.'

/**
 * A saída estruturada de cada turno, ao lado da resposta em texto (§5 do PRD).
 *
 * Os três campos saem da **mesma** chamada que gera a resposta. Uma segunda chamada por
 * turno só para medir irritação dobraria o custo do módulo.
 */
export const AgentTurnOutputSchema = z.object({
  reply: z.string().min(1).max(AGENT_REPLY_MAX),
  sentiment: AgentSentimentSchema,
  handoff: z.boolean(),
})
export type AgentTurnOutput = z.infer<typeof AgentTurnOutputSchema>

/**
 * O mesmo contrato em JSON Schema, para `output_config.format`.
 *
 * Escrito à mão em vez de derivado do Zod: o schema que vai ao provedor precisa de
 * `additionalProperties: false` e **não aceita** as restrições de tamanho que o Zod
 * acima declara. Converter automaticamente produziria um schema que o provedor recusa,
 * ou um que silenciosamente perde a validação — as duas versões existem porque as duas
 * perguntas são diferentes: uma valida o que chegou, a outra restringe o que sai.
 */
export const AGENT_TURN_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'A resposta que vai para o cliente no WhatsApp, em português do Brasil.',
    },
    sentiment: {
      type: 'string',
      enum: AGENT_SENTIMENTS,
      description: 'Como o cliente parece estar se sentindo nesta mensagem.',
    },
    handoff: {
      type: 'boolean',
      description:
        'true quando esta conversa deve passar para uma pessoa da equipe — ' +
        'porque o cliente pediu, porque está insatisfeito, ou porque você não resolve.',
    },
  },
  required: ['reply', 'sentiment', 'handoff'],
  additionalProperties: false,
} as const

// ─── Os argumentos das tools de leitura (MOD-AI-03) ──────────────────────────

/**
 * **Nenhuma tool recebe `tutorId`, e a ausência é a decisão de segurança do módulo.**
 *
 * O escopo vem da conversa, como no `requireOwnScope` do Portal — um argumento que o
 * modelo pudesse preencher seria a falha inteira (RN-02).
 */
export const ConsultarDisponibilidadeArgsSchema = z.strictObject({
  petId: z.uuid(),
  serviceIds: z.array(z.uuid()).min(1).max(10),
  /** Dia civil no fuso do tenant, resolvido pelo agente a partir de "quinta". */
  date: z.iso.date(),
})

export const ListarServicosArgsSchema = z.strictObject({ petId: z.uuid() })

export const AgentSettingsSchema = z.object({
  enabled: z.boolean(),
  opensAt: z.string().regex(/^\d{2}:\d{2}$/),
  closesAt: z.string().regex(/^\d{2}:\d{2}$/),
  monthlyCapCents: z.number().int().min(0),
  /** Quanto já se gastou no mês corrente, em centavos — leitura, nunca escrita. */
  spentCents: z.number().int(),
  /** `false` quando o motor de mensagens está desligado: o agente não teria como falar. */
  canEnable: z.boolean(),
})
export type AgentSettings = z.infer<typeof AgentSettingsSchema>

/**
 * O PATCH da configuração.
 *
 * Sem `.partial()` sobre um schema com defaults — é a armadilha que o MOD-TUTOR pagou:
 * `.partial()` não remove o default, e um campo ausente gravaria o padrão por cima do
 * que o tenant customizou. Os campos nascem opcionais, um a um.
 */
export const UpdateAgentSettingsSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    opensAt: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    closesAt: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    monthlyCapCents: z.coerce.number().int().min(0).max(10_000_00).optional(),
  })
  .refine(
    (input) =>
      input.opensAt === undefined || input.closesAt === undefined || input.opensAt < input.closesAt,
    { message: 'O horário de início precisa ser antes do de término', path: ['closesAt'] },
  )
export type UpdateAgentSettingsInput = z.output<typeof UpdateAgentSettingsSchema>
