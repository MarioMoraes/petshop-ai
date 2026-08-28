import { withTenant } from '@petshop/db'
import type { MessageListQuery, MessageStats, MessageSummary } from '@petshop/shared-types'
import { decryptOrPlaceholder, openCipher, type MessageCipher } from './crypto.js'

/**
 * Leitura do histórico e do painel (MOD-CRM-10 e MOD-CRM-11).
 *
 * O corpo é decifrado na leitura, uma DEK por página — não por linha. Com 20 itens e
 * a chave em cache, a diferença não aparece; com o histórico de um tutor antigo, ela
 * é a diferença entre uma consulta e vinte.
 */

const PURGED = '(mensagem removida pela política de retenção)'

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
    ...(query.status ? { status: query.status } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.tutorId ? { tutorId: query.tutorId } : {}),
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

    const cipher = await openCipher(tx, tenantId)
    return {
      data: rows.map((row) => toSummary(row, cipher)),
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
    const cipher = await openCipher(tx, tenantId)
    return toSummary(row, cipher)
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
        where: { status: { in: ['QUEUED', 'SCHEDULED'] } },
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
    tutorId: string
    petId: string | null
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
): MessageSummary {
  return {
    id: row.id,
    tutorId: row.tutorId,
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
    createdAt: row.createdAt.toISOString(),
  }
}
