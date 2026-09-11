import { withTenant, type TenantTransaction } from '@petshop/db'
import type { MessageListQuery, MessageStats, MessageSummary } from '@petshop/shared-types'
import { decryptOrPlaceholder, openCipher, type MessageCipher } from './crypto.js'

/**
 * Leitura do histórico e do painel (MOD-CRM-10 e MOD-CRM-11).
 *
 * O corpo é decifrado na leitura, uma DEK por página — não por linha. Com 20 itens e
 * a chave em cache, a diferença não aparece; com o histórico de um tutor antigo, ela
 * é a diferença entre uma consulta e vinte.
 *
 * O nome do destinatário segue a mesma economia: uma consulta por página sobre os ids
 * distintos, e não uma por linha. `full_name` está em claro em `tutors` — nome não é
 * dado cifrado neste modelo —, então resolvê-lo aqui não abre chave nenhuma.
 */

const PURGED = '(mensagem removida pela política de retenção)'

/**
 * O tutor foi apagado ou anonimizado depois da mensagem. A linha continua no
 * histórico — é o que AC-04 de MOD-CRM-10 preserva — e precisa de um nome para
 * ocupar a coluna.
 */
const UNKNOWN_TUTOR = 'Tutor'

/** O ex-membro cuja linha continua no histórico. Ver AC-04 de MOD-NOTIF-01. */
const UNKNOWN_USER = 'Membro da equipe'

/** Nome de exibição por id, para os tutores citados nesta página. */
async function tutorNames(
  tx: TenantTransaction,
  tutorIds: string[],
): Promise<Map<string, string>> {
  if (tutorIds.length === 0) return new Map()
  const rows = await tx.tutor.findMany({
    where: { id: { in: tutorIds } },
    select: { id: true, fullName: true, socialName: true },
  })
  return new Map(rows.map((row) => [row.id, row.socialName ?? row.fullName]))
}

/**
 * O mesmo, para os membros da equipe (MOD-NOTIF-11).
 *
 * Uma consulta por página e não por linha, como a de tutores. `users` é global e
 * `full_name` está em claro nela também — resolver o nome aqui não abre chave nenhuma,
 * e é por isso que o painel consegue dizer quem recebeu sem decifrar o destinatário.
 */
async function userNames(tx: TenantTransaction, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = await tx.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, fullName: true },
  })
  return new Map(rows.map((row) => [row.id, row.fullName]))
}

/** O que a coluna "destinatário" mostra, venha ele de onde vier. */
function displayName(
  row: { recipientKind: string; tutorId: string | null; userId: string | null },
  tutors: Map<string, string>,
  users: Map<string, string>,
): string {
  return row.recipientKind === 'USER'
    ? (row.userId ? users.get(row.userId) : undefined) ?? UNKNOWN_USER
    : (row.tutorId ? tutors.get(row.tutorId) : undefined) ?? UNKNOWN_TUTOR
}

export interface MessagePage {
  data: MessageSummary[]
  total: number
  page: number
  limit: number
}

export async function listMessages(
  tenantId: string,
  query: MessageListQuery,
): Promise<MessagePage> {
  const where = {
    /**
     * **O painel é o da fila de saída**, e desde o MOD-AI existe entrada na mesma tabela.
     *
     * Sem esta linha, a mensagem que o cliente mandou apareceria no histórico de
     * entregas como se fosse coisa que o petshop enviou — e contaria como entregue nas
     * estatísticas. Quem quer ver o que chegou pede `direction=INBOUND`; o padrão
     * continua sendo o que o painel sempre mostrou.
     */
    direction: query.direction ?? 'OUTBOUND',
    ...(query.status ? { status: query.status } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.recipientKind ? { recipientKind: query.recipientKind } : {}),
    ...(query.tutorId ? { tutorId: query.tutorId } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.templateKey ? { templateKey: query.templateKey } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  }

  return withTenant(tenantId, async (tx) => {
    const [rows, total] = await Promise.all([
      tx.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.message.count({ where }),
    ])

    const [cipher, tutors, users] = await Promise.all([
      openCipher(tx, tenantId),
      tutorNames(tx, [...new Set(rows.flatMap((row) => (row.tutorId ? [row.tutorId] : [])))]),
      userNames(tx, [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))]),
    ])
    return {
      data: rows.map((row) => toSummary(row, cipher, displayName(row, tutors, users))),
      total,
      page: query.page,
      limit: query.limit,
    }
  })
}

export async function findMessage(tenantId: string, id: string): Promise<MessageSummary | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.message.findUnique({ where: { id } })
    if (!row) return null
    const [cipher, tutors, users] = await Promise.all([
      openCipher(tx, tenantId),
      tutorNames(tx, row.tutorId ? [row.tutorId] : []),
      userNames(tx, row.userId ? [row.userId] : []),
    ])
    return toSummary(row, cipher, displayName(row, tutors, users))
  })
}

/**
 * O que o painel mostra (AC-01 de MOD-CRM-11).
 *
 * `oldestPendingSeconds` é o número que denuncia fila travada — o modo de falha mais
 * comum de motor de mensagem, e o mais silencioso: nada quebra, nada aparece no log de
 * erro, e as mensagens simplesmente param de chegar.
 */
export async function messageStats(
  tenantId: string,
  range: { from?: Date; to?: Date },
): Promise<MessageStats> {
  const where = {
    // O painel conta o que **saiu** — ver o comentário em `listMessages`. A mensagem
    // recebida não tem status de entrega que faça sentido somar aqui.
    direction: 'OUTBOUND' as const,
    ...(range.from || range.to
      ? {
          createdAt: {
            ...(range.from ? { gte: range.from } : {}),
            ...(range.to ? { lte: range.to } : {}),
          },
        }
      : {}),
  }

  return withTenant(tenantId, async (tx) => {
    const [byStatus, byReason, oldest] = await Promise.all([
      tx.message.groupBy({ by: ['status'], where, _count: true }),
      tx.message.groupBy({
        by: ['blockReason'],
        where: { ...where, status: 'BLOCKED' },
        _count: true,
      }),
      tx.message.findFirst({
        where: { direction: 'OUTBOUND', status: { in: ['QUEUED', 'SCHEDULED'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ])

    const counts = new Map(byStatus.map((row) => [row.status, row._count]))
    const blockedByReason: Record<string, number> = {}
    for (const row of byReason) {
      if (row.blockReason) blockedByReason[row.blockReason] = row._count
    }

    return {
      queued: counts.get('QUEUED') ?? 0,
      scheduled: counts.get('SCHEDULED') ?? 0,
      sent: (counts.get('SENT') ?? 0) + (counts.get('DELIVERED') ?? 0) + (counts.get('READ') ?? 0),
      delivered: (counts.get('DELIVERED') ?? 0) + (counts.get('READ') ?? 0),
      failed: counts.get('FAILED') ?? 0,
      dead: counts.get('DEAD') ?? 0,
      blocked: counts.get('BLOCKED') ?? 0,
      cancelled: counts.get('CANCELLED') ?? 0,
      merged: counts.get('MERGED') ?? 0,
      blockedByReason,
      oldestPendingSeconds: oldest
        ? Math.floor((Date.now() - oldest.createdAt.getTime()) / 1000)
        : null,
    }
  })
}

function toSummary(
  row: {
    id: string
    recipientKind: string
    tutorId: string | null
    userId: string | null
    petId: string | null
    documentId: string | null
    channel: 'WHATSAPP' | 'EMAIL'
    direction: 'OUTBOUND' | 'INBOUND'
    category: 'TRANSACTIONAL' | 'OPERATIONAL' | 'MARKETING'
    templateKey: string
    status: string
    blockReason: string | null
    subjectEncrypted: string | null
    bodyEncrypted: string
    scheduledFor: Date | null
    sentAt: Date | null
    deliveredAt: Date | null
    readAt: Date | null
    failedAt: Date | null
    attempts: number
    errorCode: string | null
    errorDetail: string | null
    createdAt: Date
  },
  cipher: MessageCipher,
  recipientName: string,
): MessageSummary {
  return {
    id: row.id,
    recipientKind: row.recipientKind as MessageSummary['recipientKind'],
    tutorId: row.tutorId,
    userId: row.userId,
    recipientName,
    // O nome antigo do campo, repetido. O Portal e a aba Mensagens da ficha só veem
    // linha de tutor, e para eles os dois valores são sempre o mesmo.
    tutorName: recipientName,
    petId: row.petId,
    channel: row.channel,
    direction: row.direction,
    category: row.category,
    templateKey: row.templateKey,
    status: row.status as MessageSummary['status'],
    blockReason: row.blockReason as MessageSummary['blockReason'],
    subject: row.subjectEncrypted ? decryptOrPlaceholder(cipher, row.subjectEncrypted) : null,
    // O corpo expurgado pela retenção vira um aviso legível, e não um erro: o
    // histórico precisa continuar navegável depois de 24 meses (AC-04 de MOD-CRM-10).
    body: decryptOrPlaceholder(cipher, row.bodyEncrypted, PURGED),
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    attempts: row.attempts,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    documentId: row.documentId,
    createdAt: row.createdAt.toISOString(),
  }
}
