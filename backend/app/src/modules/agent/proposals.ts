import { randomBytes } from 'node:crypto'
import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  AGENT_PROPOSAL_TTL_MIN,
  AppError,
  ConfirmarPropostaArgsSchema,
  ProporAgendamentoArgsSchema,
  ProporCancelamentoArgsSchema,
  ProporRemarcacaoArgsSchema,
  type AgentWriteTool,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import { openCipher } from './crypto.js'
import { getAgentPortalPort } from './portal-port.js'

/**
 * A escrita em duas etapas (MOD-AI-04).
 *
 * **O módulo inteiro existe para responder a uma pergunta: o cliente disse "sim" para
 * quê?** Em texto livre ela não tem resposta boa — o antecedente de "sim" estaria num
 * histórico que o próprio modelo resume, e um resumo que erra marca banho no dia errado.
 *
 * A resposta é uma linha de banco. O agente propõe e a proposta fica gravada com um token
 * e um prazo; a confirmação do turno seguinte aponta para **aquela** linha, e a escrita
 * acontece pela mesma função que a tela do tutor chama. Três consequências caem de
 * graça:
 *
 * 1. **uma proposta viva por conversa**, garantida pelo índice único parcial e não por
 *    uma leitura seguida de escrita que duas mensagens simultâneas atravessariam;
 * 2. **o prazo**, que protege do horário tomado no meio (AC-03);
 * 3. **o registro**, que é o que a recepção lê quando assume a conversa no meio.
 *
 * A gravação da proposta é **adiada para o fim do turno**, junto da linha do turno — ver
 * `persistToolCalls`. A confirmação, não: ela grava na hora, porque a essa altura
 * alguma coisa aconteceu no mundo.
 */

/** O que uma chamada de tool deixou para ser gravado quando o turno terminar. */
export interface ToolRecord {
  tool: string
  /** Os argumentos como o modelo os mandou. Vão cifrados. */
  args: unknown
  status: 'EXECUTED' | 'FAILED' | 'PROPOSED'
  /** Curto e em claro: "3 horários", "Pet não encontrado", "agendamento proposto". */
  summary: string
  /** Só nas propostas. */
  token?: string
  expiresAt?: Date
}

export interface ProposalScope {
  tenantId: string
  tutorId: string
  conversationId: string
  timezone: string
}

/**
 * O token da proposta.
 *
 * Trinta e dois hexadecimais de `randomBytes` — não é identificador, é segredo: quem o
 * tem confirma uma escrita. Um id sequencial ou um UUID derivado do tempo seriam
 * adivinháveis, e o modelo copia este valor de um turno para o outro em texto.
 */
export function newProposalToken(): string {
  return randomBytes(16).toString('hex')
}

export function proposalExpiry(now = new Date()): Date {
  return new Date(now.getTime() + AGENT_PROPOSAL_TTL_MIN * 60_000)
}

/**
 * Grava o que as tools do turno deixaram, com o turno já criado.
 *
 * **Por que no fim e não na hora:** a linha de `agent_turns` só nasce quando o modelo
 * termina de falar, e é ela que dá contexto a cada chamada — sem esperar, `turn_id`
 * ficaria nulo em toda linha do produto. O adiamento é seguro porque `persistTurn` roda
 * **antes** de a resposta sair pelo WhatsApp: o cliente nunca lê um "confirma?" cuja
 * proposta não esteja gravada.
 *
 * **A proposta anterior morre aqui** (AC-04). Se venceu, morre como `EXPIRED`; se o tutor
 * simplesmente pediu outra coisa, como `SUPERSEDED`. A distinção não é cosmética: uma diz
 * que o produto demorou, a outra que o cliente mudou de ideia, e o painel de qualidade
 * conta as duas separadas.
 *
 * Um turno com duas propostas guarda só a última viva, pela mesma razão — "sim" precisa
 * de um antecedente só.
 */
export async function persistToolCalls(
  tx: TenantTransaction,
  tenantId: string,
  conversationId: string,
  turnId: string,
  records: ToolRecord[],
): Promise<void> {
  if (records.length === 0) return

  const now = new Date()
  const cipher = await openCipher(tx, tenantId)

  const propostas = records.filter((record) => record.status === 'PROPOSED')
  const viva = propostas.at(-1)

  if (propostas.length > 0) await closeLiveProposal(tx, conversationId, now)

  for (const record of records) {
    const proposta = record.status === 'PROPOSED'
    // As propostas que o próprio turno superou nascem já superadas: gravá-las como
    // `PROPOSED` para atualizá-las em seguida esbarraria no índice único.
    const status = proposta && record !== viva ? 'SUPERSEDED' : record.status

    await tx.agentToolCall.create({
      data: {
        tenantId,
        conversationId,
        turnId,
        tool: record.tool.slice(0, 40),
        argumentsEncrypted: cipher.encrypt(JSON.stringify(record.args ?? {})),
        resultSummary: record.summary.slice(0, 500),
        status,
        ...(status === 'PROPOSED' && record.token && record.expiresAt
          ? { confirmationToken: record.token, expiresAt: record.expiresAt }
          : {}),
        ...(status === 'PROPOSED' ? {} : { resolvedAt: now }),
      },
    })
  }
}

/** Tira da frente a proposta viva da conversa, dizendo por quê. */
async function closeLiveProposal(
  tx: TenantTransaction,
  conversationId: string,
  now: Date,
): Promise<void> {
  const live = await tx.agentToolCall.findFirst({
    where: { conversationId, status: 'PROPOSED' },
    select: { id: true, expiresAt: true },
  })
  if (!live) return

  await tx.agentToolCall.update({
    where: { id: live.id },
    data: {
      status: live.expiresAt && live.expiresAt <= now ? 'EXPIRED' : 'SUPERSEDED',
      resolvedAt: now,
    },
  })
}

/** O que a confirmação devolve ao laço do turno. */
export interface ConfirmOutcome {
  text: string
  isError: boolean
  /** `true` quando a conversa precisa ir para gente depois desta resposta (AC-05). */
  handoff?: boolean
}

/**
 * Confirma a proposta viva da conversa e **escreve** (AC-02).
 *
 * É a única tool do módulo que muda alguma coisa fora dele, e o caminho é o do Portal:
 * `createBooking`, `cancelOwnAppointment` e `rescheduleOwnAppointment`, com os mesmos
 * gates, o mesmo preço congelado e o mesmo `canOverrideCredit: false`.
 *
 * **A posse é tomada antes da escrita.** A linha vai de `PROPOSED` a `CONFIRMED` num
 * `UPDATE` condicional, e só depois a gravação acontece; se ela falhar, a linha vai a
 * `FAILED`. Duas mensagens do tutor com "sim" chegando juntas disputam esse `UPDATE`, e
 * só uma ganha — o contrário marcaria dois banhos no mesmo horário.
 *
 * A ordem escolhe qual falha o produto prefere. Um processo que morra entre o `UPDATE` e
 * a gravação deixa uma linha dizendo `CONFIRMED` sem agendamento nenhum: o cliente
 * pergunta de novo e o agente propõe outra vez. A ordem inversa deixaria o agendamento
 * feito e a proposta viva, e o "sim" seguinte marcaria o segundo. **Perder uma escrita é
 * recuperável; duplicá-la, não.**
 */
export async function confirmProposal(
  scope: ProposalScope,
  rawArgs: unknown,
): Promise<ConfirmOutcome> {
  const parsed = ConfirmarPropostaArgsSchema.safeParse(rawArgs)
  if (!parsed.success) {
    return { text: 'Falta o código da proposta para confirmar.', isError: true }
  }

  const now = new Date()
  const claimed = await withTenant(scope.tenantId, async (tx) => {
    const live = await tx.agentToolCall.findFirst({
      where: { conversationId: scope.conversationId, status: 'PROPOSED' },
      select: {
        id: true,
        tool: true,
        argumentsEncrypted: true,
        confirmationToken: true,
        expiresAt: true,
      },
    })
    if (!live) return { kind: 'none' as const }

    /**
     * Token errado não diz **qual** é o certo, e a resposta é a mesma de não haver
     * proposta: o modelo é quem copia esse valor de um turno para o outro, e uma
     * mensagem que diferenciasse os dois casos o ensinaria a tentar de novo.
     */
    if (live.confirmationToken !== parsed.data.confirmationToken) return { kind: 'none' as const }

    if (!live.expiresAt || live.expiresAt <= now) {
      await tx.agentToolCall.update({
        where: { id: live.id },
        data: { status: 'EXPIRED', resolvedAt: now },
      })
      return { kind: 'expired' as const }
    }

    // A posse: quem move de `PROPOSED` é quem escreve. `updateMany` para a condição
    // entrar no `WHERE` da própria escrita, e não numa leitura anterior a ela.
    const taken = await tx.agentToolCall.updateMany({
      where: { id: live.id, status: 'PROPOSED' },
      data: { status: 'CONFIRMED', resolvedAt: now },
    })
    if (taken.count !== 1) return { kind: 'none' as const }

    const cipher = await openCipher(tx, scope.tenantId)
    return {
      kind: 'ok' as const,
      id: live.id,
      tool: live.tool as AgentWriteTool,
      args: JSON.parse(cipher.decrypt(live.argumentsEncrypted)) as unknown,
    }
  })

  if (claimed.kind === 'none') {
    return {
      text: 'Não há nenhuma proposta esperando confirmação nesta conversa. Refaça a consulta e ofereça de novo.',
      isError: true,
    }
  }

  if (claimed.kind === 'expired') {
    // AC-03: a proposta envelheceu e o horário pode ter sido tomado no meio. O agente
    // não confirma por cima — consulta de novo e propõe outra vez, que é o que uma
    // pessoa faria.
    return {
      text:
        'Esta proposta venceu (vale por ' +
        `${AGENT_PROPOSAL_TTL_MIN} minutos). Consulte a disponibilidade de novo e ` +
        'proponha o horário ao cliente mais uma vez.',
      isError: true,
    }
  }

  try {
    const done = await execute(scope, claimed.tool, claimed.args)
    await settle(scope, claimed.id, 'CONFIRMED', done.summary, {
      action: done.audit,
      appointmentId: done.appointmentId,
    })
    if (done.event) {
      await publishEvent('agente.agendamento.criado', {
        tenantId: scope.tenantId,
        conversationId: scope.conversationId,
        appointmentId: done.appointmentId,
      })
    }
    return { text: done.text, isError: false }
  } catch (error) {
    return failure(scope, claimed.id, claimed.tool, error)
  }
}

// ─── A escrita ───────────────────────────────────────────────────────────────

interface Written {
  text: string
  summary: string
  appointmentId: string
  audit: 'agent.booking_created' | 'agent.booking_cancelled' | 'agent.booking_rescheduled'
  event: boolean
}

async function execute(
  scope: ProposalScope,
  tool: AgentWriteTool,
  args: unknown,
): Promise<Written> {
  const port = getAgentPortalPort()
  const { tenantId, tutorId } = scope

  if (tool === 'proporAgendamento') {
    const input = ProporAgendamentoArgsSchema.parse(args)
    const created = await port.book(tenantId, tutorId, input)
    return {
      text: JSON.stringify({
        agendamentoId: created.id,
        quando: created.startsAt,
        pet: created.petName,
        profissional: created.professionalName,
        servicos: created.services,
        // O `PENDING` do MOD-AGENDA: marcado, mas ainda depende da triagem do petshop. O
        // cliente precisa ouvir isso agora, e não descobrir na véspera.
        aguardandoConfirmacaoDoPetshop: created.awaitingApproval,
      }),
      summary: created.awaitingApproval
        ? 'agendamento criado, aguardando confirmação do petshop'
        : 'agendamento criado',
      appointmentId: created.id,
      audit: 'agent.booking_created',
      event: true,
    }
  }

  if (tool === 'proporCancelamento') {
    const input = ProporCancelamentoArgsSchema.parse(args)
    const cancelled = await port.cancelAppointment(tenantId, tutorId, input.appointmentId)
    return {
      text: JSON.stringify({ agendamentoId: cancelled.id, situacao: 'cancelado' }),
      summary: cancelled.cancelledLate ? 'agendamento cancelado (tardio)' : 'agendamento cancelado',
      appointmentId: cancelled.id,
      audit: 'agent.booking_cancelled',
      event: false,
    }
  }

  const input = ProporRemarcacaoArgsSchema.parse(args)
  const moved = await port.rescheduleAppointment(tenantId, tutorId, input.appointmentId, {
    professionalId: input.professionalId,
    startsAt: input.startsAt,
  })
  return {
    text: JSON.stringify({
      agendamentoId: moved.id,
      quando: moved.startsAt,
      pet: moved.petName,
      profissional: moved.professionalName,
      aguardandoConfirmacaoDoPetshop: moved.awaitingApproval,
    }),
    summary: 'agendamento remarcado',
    appointmentId: moved.id,
    audit: 'agent.booking_rescheduled',
    event: false,
  }
}

/**
 * O que o cliente ouve quando a escrita é recusada (AC-05).
 *
 * **A mensagem do domínio não é repassada ao modelo**, e a razão é a RN-01. Os textos do
 * Portal foram escritos para uma tela com sessão iniciada, e um deles diz o valor exato
 * da dívida — "Há R$ 240,00 em aberto na sua conta". Aqui a prova de identidade é o
 * número de quem escreveu, e o produto não diz valores por este canal. O motivo completo
 * vai para `result_summary` e para o log, que é onde a recepção o lê.
 *
 * A exceção é o horário que acabou de ser tomado: não há nada de sensível nisso, o agente
 * consulta de novo e propõe outro — mandar essa conversa para gente seria desistir de um
 * caso que o próprio agente resolve.
 */
async function failure(
  scope: ProposalScope,
  id: string,
  tool: AgentWriteTool,
  error: unknown,
): Promise<ConfirmOutcome> {
  const code = error instanceof AppError ? error.code : 'ERRO'
  const detail = error instanceof AppError ? error.message : 'falha inesperada'

  logger.warn(
    { tenantId: scope.tenantId, conversationId: scope.conversationId, tool, code, err: error },
    'escrita do agente recusada',
  )

  if (code === 'ERR_AGENDA_004') {
    await settle(scope, id, 'FAILED', `horário indisponível (${code})`)
    return {
      text: 'Este horário acabou de ser preenchido. Consulte a disponibilidade de novo e ofereça outro ao cliente.',
      isError: true,
    }
  }

  await settle(scope, id, 'FAILED', `${code}: ${detail}`)
  return {
    text:
      'Não consegui concluir este pedido. Diga ao cliente, sem dar detalhes técnicos, que ' +
      'alguém da equipe vai continuar o atendimento — e passe a conversa adiante.',
    isError: true,
    handoff: true,
  }
}

interface Settlement {
  action?: Written['audit']
  appointmentId?: string
}

/**
 * Fecha a linha da proposta e deixa a trilha (AC-07).
 *
 * A trilha do domínio grava `actor_user_id` nulo — o tutor não tem sessão no Clerk, e o
 * chamador é um sentinela. Esta linha é o que diz quem realmente pediu: **a conversa e o
 * turno**, que meses depois respondem "quem marcou isso" com a frase que o cliente
 * escreveu.
 */
async function settle(
  scope: ProposalScope,
  id: string,
  status: 'CONFIRMED' | 'FAILED',
  summary: string,
  settlement: Settlement = {},
): Promise<void> {
  await withTenant(scope.tenantId, async (tx) => {
    await tx.agentToolCall.update({
      where: { id },
      data: { status, resultSummary: summary.slice(0, 500), resolvedAt: new Date() },
    })

    if (!settlement.action) return

    const conversation = await tx.agentConversation.findUnique({
      where: { id: scope.conversationId },
      select: { turnCount: true },
    })

    await recordAudit(tx, {
      tenantId: scope.tenantId,
      actorUserId: null,
      action: settlement.action,
      entity: 'appointments',
      entityId: settlement.appointmentId ?? id,
      after: {
        conversationId: scope.conversationId,
        turn: conversation?.turnCount ?? 0,
        tutorId: scope.tutorId,
        toolCallId: id,
      },
    })
  })
}
