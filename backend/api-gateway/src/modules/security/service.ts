import { decryptPlatform, getPrisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  AUDIT_QUERY_DEFAULT_DAYS,
  AUDIT_QUERY_MAX_DAYS,
  maskEmail,
  type AuditLogEntry,
  type AuditLogQuery,
  type AuditPage,
  type SecurityEventEntry,
  type SecurityEventQuery,
  type SecurityEventSummary,
  type SecurityEventTypeKey,
} from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { invalidQuery } from './errors.js'

/**
 * A leitura da trilha (MOD-SEC-04 e MOD-SEC-05).
 *
 * O módulo **só lê**. Quem escreve em `audit_logs` é o `recordAudit` de quem alterou
 * algo, dentro da transação da alteração; quem escreve em `security_events` é uma
 * recusa. Aqui não há um único `create`, e é o que faz este arquivo curto.
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface Window {
  from: Date
  to: Date
}

/**
 * A janela da consulta, com teto.
 *
 * O teto de 92 dias não é desempenho: é forma de uso. Sem ele, a primeira coisa que
 * alguém faz é pedir dois anos de trilha e receber uma página de cinquenta linhas de
 * anteontem — a consulta é cara, o resultado não responde nada, e a pessoa conclui que
 * a tela não funciona.
 */
function resolveWindow(query: { from?: string; to?: string }): Window {
  const to = query.to ? new Date(query.to) : new Date()
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - AUDIT_QUERY_DEFAULT_DAYS * DAY_MS)

  if (from.getTime() > to.getTime()) {
    throw invalidQuery('O início do período é posterior ao fim')
  }
  if (to.getTime() - from.getTime() > AUDIT_QUERY_MAX_DAYS * DAY_MS) {
    throw invalidQuery(`O período máximo de consulta é de ${AUDIT_QUERY_MAX_DAYS} dias`)
  }
  return { from, to }
}

interface Cursor {
  createdAt: Date
  id: string
}

/**
 * O cursor é `(created_at, id)`, e **nunca** um `OFFSET`.
 *
 * Paginar por offset numa tabela append-only tem dois defeitos ao mesmo tempo: a página
 * 40 faz o banco varrer as 39 anteriores, e uma linha nova gravada entre dois cliques
 * empurra tudo, fazendo a página seguinte repetir o que a anterior já mostrou. O par
 * ordenado não tem nenhum dos dois.
 */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url')
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
  if (!iso || !id) throw invalidQuery('Cursor inválido')
  const createdAt = new Date(iso)
  if (Number.isNaN(createdAt.getTime())) throw invalidQuery('Cursor inválido')
  return { createdAt, id }
}

/** O `WHERE` do cursor: estritamente anterior ao par que fechou a página passada. */
function cursorWhere(cursor: Cursor | null) {
  if (!cursor) return {}
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  }
}

interface Actor {
  name: string | null
  emailMasked: string | null
}

/**
 * Quem agiu, resolvido em lote.
 *
 * `users` é tabela global, sem RLS — a consulta é direta, fora de `withTenant`. O que a
 * mantém honesta é que os ids vieram de linhas que o RLS já filtrou por tenant: nunca
 * se pergunta por um usuário que a página não devolveu.
 *
 * **O e-mail sai mascarado.** Quem lê a trilha está auditando colegas: precisa
 * distinguir duas pessoas de mesmo nome, não obter a lista de e-mails da equipe por uma
 * rota que não passa pelo `team:read`.
 */
async function resolveActors(userIds: string[]): Promise<Map<string, Actor>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const users = await getPrisma().user.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true, emailEncrypted: true },
  })

  return new Map(
    users.map((user) => {
      let emailMasked: string | null = null
      try {
        emailMasked = maskEmail(decryptPlatform(user.emailEncrypted))
      } catch (error) {
        // Chave rotacionada, linha de outra instalação: a trilha continua legível sem o
        // e-mail. Falhar a página inteira por causa de um campo decorativo seria pior.
        logger.warn({ err: error, userId: user.id }, 'não foi possível decifrar o e-mail do ator')
      }
      return [user.id, { name: user.fullName, emailMasked }]
    }),
  )
}

function actorOf(actors: Map<string, Actor>, actorUserId: string | null) {
  const actor = actorUserId ? actors.get(actorUserId) : undefined
  return {
    actorKind: (actorUserId ? 'USER' : 'SYSTEM') as 'USER' | 'SYSTEM',
    actorUserId,
    actorName: actor?.name ?? null,
    actorEmailMasked: actor?.emailMasked ?? null,
  }
}

export async function listAuditLogs(
  tenantId: string,
  query: AuditLogQuery,
): Promise<AuditPage<AuditLogEntry>> {
  const window = resolveWindow(query)
  const cursor = decodeCursor(query.cursor)

  const rows = await withTenant(tenantId, (tx: TenantTransaction) =>
    tx.auditLog.findMany({
      where: {
        createdAt: { gte: window.from, lte: window.to },
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.entity ? { entity: query.entity } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...cursorWhere(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Uma a mais: é como se sabe que há próxima página sem contar a tabela.
      take: query.limit + 1,
    }),
  )

  const page = rows.slice(0, query.limit)
  const actors = await resolveActors(
    page.map((row) => row.actorUserId).filter((id): id is string => id !== null),
  )

  return {
    items: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      outcome: row.outcome,
      ...actorOf(actors, row.actorUserId),
      ipAddress: row.ipAddress,
      // Já redigido na escrita por `sanitize()`. Não há caminho de desredação: o valor
      // não foi cifrado, foi descartado, e não existe mais em lugar nenhum.
      before: row.before,
      after: row.after,
    })),
    nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
  }
}

export async function listSecurityEvents(
  tenantId: string,
  query: SecurityEventQuery,
): Promise<AuditPage<SecurityEventEntry>> {
  const window = resolveWindow(query)
  const cursor = decodeCursor(query.cursor)

  const rows = await withTenant(tenantId, (tx: TenantTransaction) =>
    tx.securityEvent.findMany({
      where: {
        createdAt: { gte: window.from, lte: window.to },
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...cursorWhere(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    }),
  )

  const page = rows.slice(0, query.limit)
  const actors = await resolveActors(
    page.map((row) => row.actorUserId).filter((id): id is string => id !== null),
  )

  return {
    items: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      type: row.type as SecurityEventTypeKey,
      ...actorOf(actors, row.actorUserId),
      targetEntity: row.targetEntity,
      targetId: row.targetId,
      ipAddress: row.ipAddress,
    })),
    nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
  }
}

/**
 * A contagem por tipo no período (MOD-SEC-05 AC-02).
 *
 * É o que a tela mostra antes de alguém pedir o detalhe: uma linha isolada de
 * `PERMISSION_DENIED` não diz nada, e trinta num dia dizem que alguém está tentando
 * chegar onde não deve. O padrão é a informação; a linha é a evidência.
 */
export async function summarizeSecurityEvents(
  tenantId: string,
  query: SecurityEventQuery,
): Promise<SecurityEventSummary[]> {
  const window = resolveWindow(query)

  const grouped = await withTenant(tenantId, (tx: TenantTransaction) =>
    tx.securityEvent.groupBy({
      by: ['type'],
      where: {
        createdAt: { gte: window.from, lte: window.to },
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      },
      _count: { _all: true },
    }),
  )

  return grouped
    .map((row) => ({ type: row.type as SecurityEventTypeKey, count: row._count._all }))
    .sort((a, b) => b.count - a.count)
}
