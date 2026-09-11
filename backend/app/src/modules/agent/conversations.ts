import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  AGENT_SESSION_TTL_MIN,
  type AgentConversationStatus,
  type AgentHandoffReason,
} from '@petshop/shared-types'
import type { InboundMessage } from '../messaging/ports/agent.js'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import { openCipher } from './crypto.js'
import { getAgentMessagingPort } from './messaging-port.js'
import { getModelPort } from './model-port.js'
import { scheduleTurn } from './runner.js'
import { loadSettings } from './settings.js'

/**
 * A conversa (MOD-AI-02) e o que acontece quando uma mensagem chega (MOD-AI-01).
 *
 * **Nesta fatia toda conversa termina na recepção**, e o motivo é a única informação que
 * a fila realmente precisa: número desconhecido, telefone em duas fichas, mídia que não
 * se lê, ou simplesmente o agente que ainda não existe. O AC-02 de MOD-AI-07 já descreve
 * esse estado como legítimo e permanente — "o agente desligado grava a mensagem e manda
 * a conversa para a fila; o inbox continua funcionando" —, então o que entra aqui não é
 * um andaime que a fatia seguinte derruba: é o caminho do agente desligado, que vai
 * continuar valendo para todo petshop que não ligar o modelo.
 */

/** A janela em que "sim" ainda se refere a alguma coisa (AC-02 de MOD-AI-02). */
const SESSION_TTL_MS = AGENT_SESSION_TTL_MIN * 60_000

/** Os estados em que a conversa ainda recebe turno. */
const LIVE: AgentConversationStatus[] = ['ACTIVE', 'HANDOFF', 'ASSIGNED']

/**
 * O que impede **esta mensagem** de ser respondida pelo modelo.
 *
 * `null` quer dizer "nada impede, o agente que decida" — e daí em diante a decisão é do
 * `runner.ts`, que pesa configuração, horário, teto e o que o modelo responder.
 *
 * A ordem das perguntas é a ordem da gravidade, e ela importa: um áudio de um número
 * desconhecido é, antes de tudo, um número desconhecido — quem abre a fila precisa saber
 * que não há ficha, porque é isso que decide o que fazer a seguir.
 *
 * As três são **anteriores ao agente** de propósito: nenhuma delas justifica gastar uma
 * chamada ao modelo, e a do número desconhecido não pode nem receber resposta — responder
 * já diria a quem escreveu que aquele número não está na base (AC-02 de MOD-AI-01).
 */
async function blockedReason(message: InboundMessage): Promise<AgentHandoffReason | null> {
  if (message.candidates.length === 0) return 'UNKNOWN_NUMBER'
  if (message.candidates.length > 1) return 'AMBIGUOUS'
  if (message.kind !== 'TEXT') return 'MEDIA'

  /**
   * O agente desligado é decidido **aqui**, e não no turno.
   *
   * O turno também confere — é a corrida de alguém desligar o agente entre a mensagem
   * chegar e ela ser respondida. Mas deixar só lá faria a conversa passar por um estado
   * `ACTIVE` que dura o tempo de um agendamento para nada, e a fila da recepção só a
   * mostraria depois. Quem está esperando resposta não deve esperar um ciclo de job por
   * causa de uma configuração que já era conhecida.
   */
  const settings = await loadSettings(message.tenantId)
  if (!settings.enabled || !getModelPort().configured) return 'DISABLED'

  return null
}

/**
 * Abre, reaproveita ou renova a conversa e registra o turno.
 *
 * Roda inteiro numa transação: a mensagem já está gravada em `messages` quando esta
 * função começa, e uma conversa que nascesse pela metade deixaria um turno órfão na
 * fila da recepção apontando para uma conversa sem dono.
 */
export async function handleInbound(message: InboundMessage): Promise<void> {
  const result = await withTenant(message.tenantId, async (tx) => {
    const cipher = await openCipher(tx, message.tenantId)
    const now = message.receivedAt

    const existing = await tx.agentConversation.findFirst({
      where: { contactHash: message.phoneHash, status: { in: LIVE } },
      orderBy: { lastTurnAt: 'desc' },
      select: { id: true, status: true, tutorId: true, turnCount: true, lastTurnAt: true },
    })

    /**
     * A conversa calada há mais de duas horas não continua: ela **fecha** e outra nasce.
     *
     * Só vale para a que o agente conduzia. A que já está com a recepção não expira — lá
     * existe gente devendo resposta, e uma fila que se esvazia sozinha é uma fila que
     * esconde trabalho não feito.
     */
    const expired =
      existing?.status === 'ACTIVE' &&
      now.getTime() - existing.lastTurnAt.getTime() > SESSION_TTL_MS

    const encerrada =
      expired && existing ? { id: existing.id, outcome: await close(tx, existing.id, now) } : null

    const conversation =
      existing && !expired
        ? existing
        : await tx.agentConversation.create({
            data: {
              tenantId: message.tenantId,
              ...(message.tutorId ? { tutorId: message.tutorId } : {}),
              channel: 'WHATSAPP',
              contactEncrypted: cipher.encrypt(message.phone),
              contactHash: message.phoneHash,
              status: 'ACTIVE',
              lastTurnAt: now,
            },
            select: { id: true, status: true, tutorId: true, turnCount: true, lastTurnAt: true },
          })

    await tx.agentTurn.create({
      data: {
        tenantId: message.tenantId,
        conversationId: conversation.id,
        role: 'TUTOR',
        kind: message.kind,
        messageId: message.messageId,
        contentEncrypted: cipher.encrypt(message.text),
      },
    })

    const blocked = await blockedReason(message)
    const viva = conversation.status === 'ACTIVE'
    const goesToHandoff = viva && blocked !== null

    await tx.agentConversation.update({
      where: { id: conversation.id },
      data: {
        lastTurnAt: now,
        turnCount: { increment: 1 },
        /**
         * A ficha cadastrada **depois** da primeira mensagem entra na conversa que já
         * existia. É o caso comum de balcão: o cliente manda mensagem, a recepção o
         * cadastra ali mesmo, e a conversa aberta continua sendo a dele.
         */
        ...(!conversation.tutorId && message.tutorId ? { tutorId: message.tutorId } : {}),
        ...(goesToHandoff
          ? { status: 'HANDOFF' as const, handoffReason: blocked, handoffAt: now }
          : {}),
        /**
         * O turno entra na **fila do agente** (§8 do PRD): o carimbo diz desde quando há
         * mensagem esperando resposta, e é o que o varredor recolhe se o processo cair
         * antes de responder.
         *
         * Só quando a conversa ainda é do agente. Na que já está com a recepção, a
         * mensagem nova é registro — quem responde é gente (AC-05 de MOD-AI-05).
         */
        ...(viva && !goesToHandoff ? { pendingAt: now } : {}),
      },
    })

    if (goesToHandoff) {
      await recordAudit(tx, {
        tenantId: message.tenantId,
        actorUserId: null,
        action: 'agent.handoff',
        entity: 'agent_conversations',
        entityId: conversation.id,
        after: { reason: blocked },
      })
    }

    return {
      conversationId: conversation.id,
      tutorId: conversation.tutorId ?? message.tutorId,
      reason: blocked,
      goesToHandoff,
      pendente: viva && !goesToHandoff,
      encerrada,
    }
  })

  // A conversa que venceu enquanto esta mensagem chegava fecha com o mesmo evento de
  // qualquer outro encerramento. Sem ele, o desfecho de uma conversa expirada seria o
  // único que o painel de qualidade não veria acontecer.
  if (result.encerrada?.outcome) {
    await publishClosed(message.tenantId, result.encerrada.id, result.encerrada.outcome)
  }

  await publishEvent('agente.mensagem.recebida', {
    tenantId: message.tenantId,
    conversationId: result.conversationId,
    tutorId: result.tutorId,
  })

  if (result.goesToHandoff && result.reason) {
    await publishEvent('agente.handoff', {
      tenantId: message.tenantId,
      conversationId: result.conversationId,
      reason: result.reason,
    })
    // AC-05 de MOD-AI-01: o áudio é respondido **uma vez**, dizendo que não dá para ouvir
    // por aqui. Só quando o agente está ligado — um petshop que nunca prometeu
    // atendimento automático não deve começar a mandar frases de robô.
    if (result.reason === 'MEDIA') await warnAboutMedia(message, result.conversationId)
  }

  /**
   * O turno do modelo começa **depois** da resposta do webhook, e a promessa fica solta
   * de propósito.
   *
   * A Evolution reenvia o que não recebe 2xx rapidamente, e um turno com duas consultas
   * leva dezenas de segundos — esperar por ele aqui faria a mesma mensagem chegar de novo
   * enquanto a primeira ainda estivesse sendo respondida. O que sustenta o `void` é o
   * carimbo `pending_at` gravado acima: se este processo morrer no meio, o varredor da
   * grade recolhe o turno noventa segundos depois. É o mesmo contrato do despacho de
   * mensagens, e a razão de ele não ser um `await`.
   */
  if (result.pendente) scheduleTurn(message.tenantId, result.conversationId)

  logger.info(
    { tenantId: message.tenantId, conversationId: result.conversationId, reason: result.reason },
    'Mensagem recebida pelo WhatsApp',
  )
}

/**
 * A única frase que o agente manda sem ter sido chamado (AC-05 de MOD-AI-01).
 *
 * Áudio, imagem e documento não se leem: o corpo não é guardado e não há o que responder.
 * Dizer isso uma vez evita o cliente ficar repetindo o áudio achando que não chegou.
 */
async function warnAboutMedia(message: InboundMessage, conversationId: string): Promise<void> {
  if (!message.tutorId) return
  const settings = await loadSettings(message.tenantId)
  if (!settings.enabled) return

  try {
    await getAgentMessagingPort().sendReply({
      actor: { tenantId: message.tenantId },
      tutorId: message.tutorId,
      conversationId,
      text:
        'Recebi seu arquivo, mas por aqui só consigo ler mensagens de texto. ' +
        'Já estou chamando alguém da equipe para te atender.',
      dedupeKey: `agent-media:${message.messageId}`,
    })
  } catch (error) {
    logger.error({ err: error, conversationId }, 'não foi possível avisar sobre a mídia')
  }
}

/**
 * Encerra a conversa e publica o desfecho.
 *
 * **Resolvida é a que terminou sem passar por gente** (AC-02 de MOD-AI-09): a avaliação
 * é do desfecho observável, e não do que o modelo achou que tinha resolvido.
 */
export async function close(
  tx: TenantTransaction,
  conversationId: string,
  now: Date,
): Promise<{ turns: number; costCents: number; resolved: boolean } | null> {
  const row = await tx.agentConversation.findUnique({
    where: { id: conversationId },
    select: { status: true, turnCount: true, costMillicents: true, handoffReason: true },
  })
  if (!row || row.status === 'CLOSED') return null

  await tx.agentConversation.update({
    where: { id: conversationId },
    data: { status: 'CLOSED', closedAt: now },
  })

  return {
    turns: row.turnCount,
    // O evento fala em centavos, que é a unidade que quem o consome entende; o banco
    // guarda milésimos, que é a unidade em que um turno tem valor diferente de zero.
    costCents: Math.round(row.costMillicents / 1000),
    resolved: row.handoffReason === null,
  }
}

/** O evento do encerramento, publicado fora da transação como todos os outros. */
export async function publishClosed(
  tenantId: string,
  conversationId: string,
  outcome: { turns: number; costCents: number; resolved: boolean },
): Promise<void> {
  await publishEvent('agente.conversa.encerrada', { tenantId, conversationId, ...outcome })
}
