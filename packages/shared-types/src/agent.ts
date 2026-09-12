import { z } from 'zod'
import { formatBRL } from './money.js'

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
 *   de gasto e as saídas para handoff. Tudo o que ele não resolve volta para a fila;
 * - **a escrita** (fatia 3): marcar, cancelar e remarcar em duas etapas — proposta
 *   gravada com token e prazo, confirmação que aponta para ela. Ver `AGENT_TOOL_CALL_*`.
 */

export const AGENT_CONVERSATION_STATUSES = ['ACTIVE', 'HANDOFF', 'ASSIGNED', 'CLOSED'] as const
export const AgentConversationStatusSchema = z.enum(AGENT_CONVERSATION_STATUSES)
export type AgentConversationStatus = z.infer<typeof AgentConversationStatusSchema>

/**
 * Por que a conversa está na mão de gente.
 *
 * **Os seis primeiros são os do §6 do PRD; os seis últimos não estão lá**, e a razão é
 * que o §6 desenha a máquina do agente respondendo — pedido, sentimento, impasse, teto,
 * erro. Quase todo caminho do módulo termina na recepção, e sem um motivo que diga
 * **qual** caminho foi, a fila mostraria dez conversas idênticas e a recepção abriria uma
 * por uma para descobrir que três são do mesmo número desconhecido.
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
  /**
   * A mensagem chegou fora da janela do agente (AC-04 de MOD-AI-05).
   *
   * Era `DISABLED` até a fatia 3, e a fila lia "o atendimento automático está desligado"
   * quando a verdade era "ainda não abriu". São duas coisas diferentes para quem abre a
   * fila de manhã: uma pede configuração, a outra pede só responder.
   */
  'OUT_OF_HOURS',
  /**
   * O tutor confirmou e o domínio recusou (AC-05 de MOD-AI-04).
   *
   * Inadimplência com bloqueio ligado, horário que acabou de ser tomado, alerta clínico
   * crítico. **O agente não insiste nem contorna** — e o que a recepção precisa ver na
   * fila é que houve um pedido que não passou.
   */
  'WRITE_FAILED',
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
  OUT_OF_HOURS: 'A mensagem chegou fora do horário de atendimento',
  WRITE_FAILED: 'O pedido do cliente não pôde ser concluído',
}

/** Quem falou no turno. `AGENT` é o modelo; `STAFF`, a recepção respondendo pela tela. */
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

/**
 * O ciclo de uma chamada de tool (MOD-AI-04).
 *
 * Leitura nasce e morre no mesmo turno, em `EXECUTED` ou `FAILED`. Escrita entra por
 * `PROPOSED` e sai por um dos três desfechos: o tutor confirmou, pediu outra coisa, ou
 * demorou demais. **`CONFIRMED` é o único estado em que alguma coisa foi gravada** — e é
 * por isso que a máquina existe: sem ela, "sim" seria a interpretação de uma palavra de
 * duas letras sobre um histórico que o próprio modelo resume.
 */
export const AGENT_TOOL_CALL_STATUSES = [
  'EXECUTED',
  'PROPOSED',
  'CONFIRMED',
  'SUPERSEDED',
  'EXPIRED',
  'FAILED',
] as const
export const AgentToolCallStatusSchema = z.enum(AGENT_TOOL_CALL_STATUSES)
export type AgentToolCallStatus = z.infer<typeof AgentToolCallStatusSchema>

/**
 * O rótulo curto do estado, para o selo ao lado do resumo.
 *
 * Escrito do ponto de vista de **quem abre a conversa**, e não do modelo: o que a
 * recepção precisa saber de uma proposta é se ela ainda espera resposta lá fora.
 */
export const AGENT_TOOL_CALL_LABELS: Record<AgentToolCallStatus, string> = {
  EXECUTED: 'consulta',
  PROPOSED: 'esperando confirmação',
  CONFIRMED: 'confirmado pelo cliente',
  SUPERSEDED: 'o cliente pediu outra coisa',
  EXPIRED: 'proposta vencida',
  FAILED: 'não deu certo',
}

/**
 * O que a recepção vê do que o agente fez, numa linha.
 *
 * **Os argumentos não vêm** — estão cifrados e carregam id de pet, data e horário, que
 * não dizem nada a quem lê a conversa. O que diz é `resultSummary`: "3 horários",
 * "agendamento criado", "Pet não encontrado".
 */
export const AgentToolCallViewSchema = z.object({
  id: z.uuid(),
  tool: z.string(),
  status: AgentToolCallStatusSchema,
  resultSummary: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type AgentToolCallView = z.infer<typeof AgentToolCallViewSchema>

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
  /**
   * O que o agente fez nesta conversa, na ordem em que fez (MOD-AI-04).
   *
   * A recepção que assume precisa saber se o cliente já tem um horário proposto esperando
   * "sim" — atender sem isso é oferecer de novo o que já foi oferecido, ou marcar em
   * cima de uma proposta viva.
   */
  toolCalls: z.array(AgentToolCallViewSchema),
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

// ─── As tools de escrita (MOD-AI-04) ─────────────────────────────────────────

/**
 * Quanto tempo uma proposta vale (AC-03 de MOD-AI-04).
 *
 * Quinze minutos. Não é impaciência: **o horário pode ter sido tomado no meio**, e
 * confirmar sobre uma proposta velha criaria um conflito que o gate do MOD-AGENDA
 * recusaria com uma mensagem que o tutor não entenderia. Vencida, o agente refaz a
 * consulta e propõe de novo — que é o que uma pessoa faria.
 */
export const AGENT_PROPOSAL_TTL_MIN = 15

/**
 * As três escritas, sempre em duas etapas, e a quarta que é a única que grava.
 *
 * A lista é curta de propósito, e a curtidão **é** a regra (AC-06, RN-06): não existe
 * tool de lançamento financeiro, de registro clínico, de alteração de ficha nem de envio
 * de campanha. **A lista de tools é a fronteira do que o agente pode fazer** — o que não
 * está aqui ele não faz, e não porque o prompt pede.
 */
export const AGENT_WRITE_TOOLS = [
  'proporAgendamento',
  'proporCancelamento',
  'proporRemarcacao',
] as const
export type AgentWriteTool = (typeof AGENT_WRITE_TOOLS)[number]

export const ProporAgendamentoArgsSchema = z.strictObject({
  petId: z.uuid(),
  serviceIds: z.array(z.uuid()).min(1).max(10),
  professionalId: z.uuid(),
  startsAt: z.iso.datetime(),
})
export type ProporAgendamentoArgs = z.output<typeof ProporAgendamentoArgsSchema>

export const ProporCancelamentoArgsSchema = z.strictObject({
  appointmentId: z.uuid(),
})
export type ProporCancelamentoArgs = z.output<typeof ProporCancelamentoArgsSchema>

export const ProporRemarcacaoArgsSchema = z.strictObject({
  appointmentId: z.uuid(),
  professionalId: z.uuid(),
  startsAt: z.iso.datetime(),
})
export type ProporRemarcacaoArgs = z.output<typeof ProporRemarcacaoArgsSchema>

/**
 * O token da confirmação.
 *
 * Opaco e conferido **dentro** da conversa: o `confirmarProposta` procura a proposta viva
 * da conversa e compara. Um token que valesse em qualquer conversa seria uma chave de
 * escrita viajando pelo WhatsApp, e o modelo é quem a copiaria de um lado para o outro.
 */
export const ConfirmarPropostaArgsSchema = z.strictObject({
  confirmationToken: z.string().min(20).max(64),
})
export type ConfirmarPropostaArgs = z.output<typeof ConfirmarPropostaArgsSchema>

// ─── O painel de qualidade (MOD-AI-09) ───────────────────────────────────────

/**
 * A janela padrão do painel: trinta dias.
 *
 * É o ciclo do teto de gasto, que é a outra pergunta que se faz nesta tela — "quanto
 * isto custou" e "quanto disto se pagou" olham o mesmo mês.
 */
export const AGENT_STATS_WINDOW_DAYS = 30

/** Teto da janela. Um ano cabe; dois fariam a média esconder a mudança recente. */
export const AGENT_STATS_MAX_DAYS = 366

export const AgentStatsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type AgentStatsQuery = z.output<typeof AgentStatsQuerySchema>

export const AgentHandoffCountSchema = z.object({
  reason: AgentHandoffReasonSchema,
  total: z.number().int(),
})
export type AgentHandoffCount = z.infer<typeof AgentHandoffCountSchema>

/**
 * O funil das escritas (MOD-AI-04), contado pela **proposta**.
 *
 * Cada proposta feita no período é contada pelo estado em que está hoje, e não pelo
 * estado em que estava ao fim do período: uma proposta de ontem confirmada hoje conta
 * como confirmada ontem. É o que um funil precisa fazer — ele segue o objeto, não o
 * relógio —, e a alternativa contaria a mesma proposta duas vezes em dois dias.
 *
 * `proposed` é a que **ainda** espera resposta. Num período que acabou de fechar ela é
 * normal; num período de um mês atrás, é conversa que o cliente abandonou.
 */
export const AgentWriteFunnelSchema = z.object({
  proposed: z.number().int(),
  confirmed: z.number().int(),
  superseded: z.number().int(),
  expired: z.number().int(),
  failed: z.number().int(),
})
export type AgentWriteFunnel = z.infer<typeof AgentWriteFunnelSchema>

export const AgentStatsSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),

  /** Conversas **encerradas** no período. É o denominador de tudo o que está abaixo. */
  conversations: z.number().int(),
  /** As que terminaram sem passar por gente (AC-02). */
  resolved: z.number().int(),
  /** 0 a 100, com uma casa. Zero conversas dá zero, e não divisão por zero. */
  resolutionRate: z.number(),

  /** Por que as outras passaram. Ordenado da mais comum para a menos. */
  handoffs: z.array(AgentHandoffCountSchema),

  /**
   * Segundos entre a mensagem do cliente e a resposta do agente.
   *
   * Nulo quando o agente não respondeu nada no período — que é o estado de quem nunca o
   * ligou, e não um zero.
   */
  avgResponseSeconds: z.number().int().nullable(),

  /** Turnos do modelo no período, e o que eles custaram. */
  turns: z.number().int(),
  costMillicents: z.number().int(),
  /** O custo médio de uma conversa encerrada, na mesma unidade. */
  avgCostMillicents: z.number().int(),

  writes: AgentWriteFunnelSchema,
})
export type AgentStats = z.infer<typeof AgentStatsSchema>

/**
 * O custo do agente em reais, na unidade em que ele **não** é zero.
 *
 * Um turno custa fração de centavo, e é por isso que o banco guarda milésimos (RN-13).
 * Arredondar para centavos na hora de exibir devolveria "R$ 0,00" para toda conversa
 * curta — que é a mentira que a coluna `cost_millicents` existe para não contar. Abaixo
 * de um centavo a tela diz isso com palavras, em vez de mostrar um zero.
 */
export function formatAgentCost(millicents: number): string {
  const cents = millicents / 1000
  if (cents > 0 && cents < 1) return 'menos de R$ 0,01'
  return formatBRL(Math.round(cents))
}
