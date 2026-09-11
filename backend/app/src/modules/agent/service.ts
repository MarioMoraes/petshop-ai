import { randomUUID } from 'node:crypto'
import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { AGENT_SESSION_TTL_MIN, type AgentReplyInput } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { close, publishClosed } from './conversations.js'
import { openCipher } from './crypto.js'
import { invalidTransition, notFound } from './errors.js'
import { getAgentMessagingPort } from './messaging-port.js'
import { canReply } from './queries.js'

/**
 * O que a recepção faz com uma conversa (MOD-AI-06).
 *
 * Três verbos, e o segundo é o único que sai do produto: assumir, responder, encerrar.
 * Não há "devolver para o agente" — o handoff é terminal (RN-07), e um agente que
 * retomasse uma conversa que prometeu passar para uma pessoa desfaria a promessa que
 * acabou de fazer.
 */

/**
 * Assume a conversa (AC-02 de MOD-AI-06).
 *
 * **Duas pessoas respondendo o mesmo cliente é pior que ninguém responder**, e é por isso
 * que assumir o que já é de outra pessoa é 409 e não um `update` que vence. Reassumir a
 * própria é idempotente: quem recarrega a tela e clica de novo não merece um erro.
 */
export async function assignConversation(actor: ActorContext, id: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.agentConversation.findUnique({
        where: { id },
        select: { status: true, assignedTo: true },
      })
      if (!row) throw notFound()

      if (row.status === 'CLOSED') {
        throw invalidTransition('Esta conversa já foi encerrada')
      }
      if (row.assignedTo && row.assignedTo !== actor.actorUserId) {
        throw invalidTransition('Outra pessoa da equipe já assumiu esta conversa')
      }

      await tx.agentConversation.update({
        where: { id },
        data: {
          status: 'ASSIGNED',
          assignedTo: actor.actorUserId ?? null,
          assignedAt: new Date(),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'agent.assigned',
        entity: 'agent_conversations',
        entityId: id,
        before: { assignedTo: row.assignedTo },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )
}

/**
 * Responde pela tela (AC-03 de MOD-AI-06).
 *
 * A ordem importa e é o oposto da intuitiva: **a mensagem sai primeiro**, e o turno só
 * nasce depois de o motor ter aceitado. O contrário deixaria na conversa uma resposta que
 * a recepção vê como enviada e que o cliente nunca recebeu — que é exatamente o modo de
 * falha que a tela existe para evitar.
 *
 * Quem responde **assume**: não faz sentido escrever para um cliente e deixar a conversa
 * na fila de todo mundo.
 */
export async function replyToConversation(
  actor: ActorContext,
  id: string,
  input: AgentReplyInput,
): Promise<void> {
  const conversation = await withTenant(actor.tenantId, (tx) =>
    tx.agentConversation.findUnique({
      where: { id },
      select: { status: true, tutorId: true, assignedTo: true },
    }),
  )
  if (!conversation) throw notFound()

  const allowed = canReply(conversation)
  if (!allowed.ok) throw invalidTransition(allowed.reason ?? 'Não é possível responder')

  const messageId = await getAgentMessagingPort().sendReply({
    actor,
    // `canReply` já garantiu que existe ficha — sem ela o motor não teria destinatário.
    tutorId: conversation.tutorId as string,
    conversationId: id,
    text: input.text,
    /**
     * Único por resposta, e **não** derivado do texto: a recepção repete "bom dia" para
     * dez clientes por manhã, e um `dedupeKey` por conteúdo devolveria a mesma mensagem
     * já enviada em vez de mandar a segunda.
     */
    dedupeKey: `agent-reply:${randomUUID()}`,
  })

  await withTenant(
    actor.tenantId,
    async (tx) => {
      const cipher = await openCipher(tx, actor.tenantId)
      const now = new Date()

      await tx.agentTurn.create({
        data: {
          tenantId: actor.tenantId,
          conversationId: id,
          role: 'STAFF',
          kind: 'TEXT',
          messageId,
          contentEncrypted: cipher.encrypt(input.text),
          ...(actor.actorUserId ? { authorId: actor.actorUserId } : {}),
        },
      })

      await tx.agentConversation.update({
        where: { id },
        data: {
          status: 'ASSIGNED',
          turnCount: { increment: 1 },
          lastTurnAt: now,
          ...(conversation.assignedTo
            ? {}
            : { assignedTo: actor.actorUserId ?? null, assignedAt: now }),
        },
      })
    },
    tenantOptions(actor),
  )
}

/** Encerra. O evento do desfecho sai fora da transação, como todos os outros. */
export async function closeConversation(actor: ActorContext, id: string): Promise<void> {
  const outcome = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.agentConversation.findUnique({
        where: { id },
        select: { status: true },
      })
      if (!row) throw notFound()
      if (row.status === 'CLOSED') throw invalidTransition('Esta conversa já foi encerrada')

      const result = await close(tx, id, new Date())

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'agent.closed',
        entity: 'agent_conversations',
        entityId: id,
        before: { status: row.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return result
    },
    tenantOptions(actor),
  )

  if (outcome) await publishClosed(actor.tenantId, id, outcome)
}

/**
 * O varredor das conversas caladas (AC-02 de MOD-AI-02).
 *
 * A expiração já é aplicada quando o tutor volta a escrever — lá ela decide entre
 * continuar e abrir outra. Este job existe para o caso em que ele **não** volta: sem ele,
 * a conversa ficaria `ACTIVE` para sempre, e "conversas abertas" deixaria de ser um
 * número que significa alguma coisa.
 *
 * **Só mexe em `ACTIVE`.** A que está com a recepção não expira: lá existe gente devendo
 * resposta, e uma fila que se esvazia sozinha é uma fila que esconde trabalho não feito.
 */
export async function sweepStaleConversations(): Promise<{ closed: number }> {
  const cutoff = new Date(Date.now() - AGENT_SESSION_TTL_MIN * 60_000)

  // O job varre todos os tenants por definição, então a busca sai do cliente de
  // manutenção — como a do `dispatch` e a da retenção. O fechamento volta para
  // `withTenant()`, um tenant por vez.
  const stale = await getMaintenancePrisma().agentConversation.findMany({
    where: { status: 'ACTIVE', lastTurnAt: { lt: cutoff } },
    select: { id: true, tenantId: true },
    take: 500,
  })

  let closed = 0
  for (const row of stale) {
    const outcome = await withTenant(row.tenantId, (tx) => close(tx, row.id, new Date()))
    if (!outcome) continue
    closed += 1
    await publishClosed(row.tenantId, row.id, outcome)
  }

  if (closed > 0) logger.info({ closed }, 'Conversas encerradas por inatividade')
  return { closed }
}
