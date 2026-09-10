import { decryptPlatform, getMaintenancePrisma } from '@petshop/db'
import {
  AUDIT_QUERY_DEFAULT_DAYS,
  AUDIT_QUERY_MAX_DAYS,
  maskEmail,
  type PlatformAuditEntry,
  type PlatformAuditPage,
  type PlatformAuditQuery,
} from '@petshop/shared-types'
import { recordPlatformAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { invalid } from './errors.js'

/**
 * A trilha cross-tenant (MOD-ADMIN-08).
 *
 * É a leitura que o MOD-SEC-05 deliberadamente **não** deu: lá a trilha é do
 * estabelecimento, filtrada pelo RLS, e nem o administrador do petshop enxerga a linha de
 * outro. Aqui ela atravessa todos, e a única justificativa para isso existir é a segunda:
 * **quem vigia também é vigiado** (AC-02). Sem esta rota, as leituras do suporte sob grant
 * ficariam visíveis só a quem foi lido — e invisíveis a quem responde pela equipe que leu.
 *
 * Por isso a própria consulta se registra (RN-13), com o filtro usado.
 *
 * A janela máxima e o cursor são os mesmos do MOD-SEC-05, e o código deles também está
 * repetido aqui de propósito: aquele leitor abre transação com tenant e vive sob RLS; este
 * lê como `app_maintenance` sem tenant nenhum. Compartilhar a implementação faria uma
 * função ter dois modos de isolamento, que é a última coisa que se quer no arquivo que
 * decide quem enxerga a trilha de quem.
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface Cursor {
  createdAt: Date
  id: string
}

function resolveWindow(query: PlatformAuditQuery): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date()
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - AUDIT_QUERY_DEFAULT_DAYS * DAY_MS)

  if (from.getTime() > to.getTime()) throw invalid('O início do período é posterior ao fim')
  if (to.getTime() - from.getTime() > AUDIT_QUERY_MAX_DAYS * DAY_MS) {
    throw invalid(`O período máximo de consulta é de ${AUDIT_QUERY_MAX_DAYS} dias`)
  }
  return { from, to }
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url')
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
  if (!iso || !id) throw invalid('Cursor inválido')
  const createdAt = new Date(iso)
  if (Number.isNaN(createdAt.getTime())) throw invalid('Cursor inválido')
  return { createdAt, id }
}

/** Estritamente anterior ao par que fechou a página passada. Nunca `OFFSET`. */
function cursorWhere(cursor: Cursor | null) {
  if (!cursor) return {}
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  }
}

export interface PlatformAuditActor {
  userId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export async function listPlatformAuditLogs(
  actor: PlatformAuditActor,
  query: PlatformAuditQuery,
): Promise<PlatformAuditPage> {
  const window = resolveWindow(query)
  const cursor = decodeCursor(query.cursor)

  const rows = await getMaintenancePrisma().auditLog.findMany({
    where: {
      createdAt: { gte: window.from, lte: window.to },
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...cursorWhere(cursor),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // Uma a mais: é como se sabe que há próxima página sem contar a tabela.
    take: query.limit + 1,
  })

  const page = rows.slice(0, query.limit)
  const [actors, tenants] = await Promise.all([
    resolveActors(page.map((row) => row.actorUserId).filter((id): id is string => id !== null)),
    resolveTenants(page.map((row) => row.tenantId).filter((id): id is string => id !== null)),
  ])

  /**
   * O registro da própria leitura (RN-13), com o filtro usado.
   *
   * Vai com `tenant_id` nulo, como toda ação de plataforma — e é o que permite a um
   * segundo administrador perguntar quem andou lendo a trilha de quem. Sem `await` de
   * propósito: o helper engole a própria falha, e uma escrita a mais no caminho de uma
   * consulta paginada não deve somar latência à página.
   */
  void recordPlatformAudit({
    action: 'platform.audit_read',
    entity: 'audit_log',
    entityId: null,
    actorUserId: actor.userId,
    after: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  return {
    items: page.map((row): PlatformAuditEntry => {
      const quem = row.actorUserId ? actors.get(row.actorUserId) : undefined
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        outcome: row.outcome,
        actorUserId: row.actorUserId,
        actorName: quem?.name ?? null,
        actorEmailMasked: quem?.emailMasked ?? null,
        tenant: (row.tenantId ? tenants.get(row.tenantId) : undefined) ?? null,
        ipAddress: row.ipAddress,
        // Já redigido na escrita por `sanitize()`. Não há caminho de desredação.
        before: row.before,
        after: row.after,
      }
    }),
    nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
  }
}

interface Actor {
  name: string | null
  emailMasked: string | null
}

/**
 * Quem agiu, resolvido em lote — com o e-mail **mascarado**.
 *
 * Mesma decisão do MOD-SEC-05, e aqui ela pesa mais: esta rota atravessa todos os
 * estabelecimentos, e o e-mail em claro faria dela a forma mais rápida de extrair a lista
 * de contatos de toda a equipe de todos os clientes do produto. A máscara distingue duas
 * pessoas de mesmo nome, que é o que auditar exige.
 */
async function resolveActors(userIds: string[]): Promise<Map<string, Actor>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const users = await getMaintenancePrisma().user.findMany({
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
        // e-mail. Falhar a página por um campo decorativo seria pior.
        logger.warn({ err: error, userId: user.id }, 'não foi possível decifrar o e-mail do ator')
      }
      return [user.id, { name: user.fullName, emailMasked }]
    }),
  )
}

/**
 * De que estabelecimento é cada linha.
 *
 * Existe porque a lista é cross-tenant: sem o nome, uma tela com trinta linhas de cinco
 * petshops diferentes é ilegível, e o id cru obrigaria a consultar outra tela para saber
 * de quem se fala.
 */
async function resolveTenants(
  tenantIds: string[],
): Promise<Map<string, { id: string; slug: string; name: string }>> {
  const unique = [...new Set(tenantIds)]
  if (unique.length === 0) return new Map()

  const rows = await getMaintenancePrisma().tenant.findMany({
    where: { id: { in: unique } },
    select: { id: true, slug: true, name: true },
  })

  return new Map(rows.map((row) => [row.id, row]))
}
