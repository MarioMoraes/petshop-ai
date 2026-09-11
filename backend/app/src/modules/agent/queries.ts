import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  AGENT_INBOUND_LABELS,
  maskPhone,
  type AgentCandidate,
  type AgentConversationDetail,
  type AgentConversationListQuery,
  type AgentConversationSummary,
  type AgentTurnView,
  type PaginatedAgentConversations,
} from '@petshop/shared-types'
import { decryptOrPlaceholder, openCipher, type AgentCipher } from './crypto.js'
import { notFound } from './errors.js'

/**
 * A fila da recepção e o histórico (MOD-AI-06).
 *
 * Leitura direta do banco, como no MOD-PORTAL: **ler é escolher um recorte**, e o
 * recorte de quem atende — quem espera há mais tempo, com que motivo, dizendo o quê — não
 * é o de nenhuma outra tela do produto.
 */

const CONVERSATION_SELECT = {
  id: true,
  tutorId: true,
  contactEncrypted: true,
  contactHash: true,
  status: true,
  handoffReason: true,
  assignedTo: true,
  turnCount: true,
  lastTurnAt: true,
  createdAt: true,
} as const

type ConversationRow = {
  id: string
  tutorId: string | null
  contactEncrypted: string
  contactHash: string
  status: string
  handoffReason: string | null
  assignedTo: string | null
  turnCount: number
  lastTurnAt: Date
  createdAt: Date
}

export async function listConversations(
  tenantId: string,
  query: AgentConversationListQuery,
): Promise<PaginatedAgentConversations> {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.waitingOverMinutes !== undefined
      ? { lastTurnAt: { lte: new Date(Date.now() - query.waitingOverMinutes * 60_000) } }
      : {}),
  }

  return withTenant(tenantId, async (tx) => {
    const [rows, total] = await Promise.all([
      tx.agentConversation.findMany({
        where,
        // A mais antiga primeiro **quando é fila**: quem espera há mais tempo é quem
        // precisa ser atendido agora. No histórico, a mais recente na frente.
        orderBy: { lastTurnAt: query.status === 'HANDOFF' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: CONVERSATION_SELECT,
      }),
      tx.agentConversation.count({ where }),
    ])

    const cipher = await openCipher(tx, tenantId)
    const [tutors, users, lastMessages] = await Promise.all([
      tutorNames(
        tx,
        rows.flatMap((row) => (row.tutorId ? [row.tutorId] : [])),
      ),
      userNames(
        tx,
        rows.flatMap((row) => (row.assignedTo ? [row.assignedTo] : [])),
      ),
      lastTurnOf(
        tx,
        rows.map((row) => row.id),
        cipher,
      ),
    ])

    return {
      data: rows.map((row) =>
        toSummary(row, cipher, tutors, users, lastMessages.get(row.id) ?? ''),
      ),
      page: query.page,
      limit: query.limit,
      total,
    }
  })
}

export async function findConversation(
  tenantId: string,
  id: string,
): Promise<AgentConversationDetail> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.agentConversation.findUnique({
      where: { id },
      select: CONVERSATION_SELECT,
    })
    if (!row) throw notFound()

    const cipher = await openCipher(tx, tenantId)
    const turnRows = await tx.agentTurn.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        kind: true,
        sentiment: true,
        authorId: true,
        contentEncrypted: true,
        createdAt: true,
      },
    })

    const [tutors, users, candidates] = await Promise.all([
      tutorNames(tx, row.tutorId ? [row.tutorId] : []),
      userNames(tx, [
        ...(row.assignedTo ? [row.assignedTo] : []),
        ...turnRows.flatMap((turn) => (turn.authorId ? [turn.authorId] : [])),
      ]),
      row.tutorId ? Promise.resolve([]) : findCandidates(tx, row.contactHash),
    ])

    const turns: AgentTurnView[] = turnRows.map((turn) => ({
      id: turn.id,
      role: turn.role,
      kind: turn.kind,
      content: contentOf(cipher, turn.contentEncrypted, turn.kind),
      sentiment: turn.sentiment,
      authorName: turn.authorId ? (users.get(turn.authorId) ?? null) : null,
      createdAt: turn.createdAt.toISOString(),
    }))

    const summary = toSummary(row, cipher, tutors, users, turns.at(-1)?.content ?? '')

    return {
      ...summary,
      turns,
      candidates,
      /**
       * **Sem ficha não há resposta pela tela**, e a recusa é honesta em vez de
       * silenciosa.
       *
       * O motor do MOD-NOTIF é a única saída do produto (RN-15) e ele exige um tutor: o
       * consentimento, a supressão e o histórico são todos por ficha. Responder por fora
       * dele seria abrir um segundo caminho de envio sem nenhuma dessas garantias — e o
       * conserto, que é cadastrar quem escreveu, leva trinta segundos e deixa a conversa
       * respondível.
       */
      canReply: canReply(row).ok,
      replyBlockedReason: canReply(row).reason,
    }
  })
}

export function canReply(row: { tutorId: string | null; status: string }): {
  ok: boolean
  reason: string | null
} {
  if (row.status === 'CLOSED') {
    return { ok: false, reason: 'Esta conversa foi encerrada' }
  }
  if (!row.tutorId) {
    return {
      ok: false,
      reason: 'Cadastre o tutor com este telefone para responder pelo sistema',
    }
  }
  return { ok: true, reason: null }
}

function toSummary(
  row: ConversationRow,
  cipher: AgentCipher,
  tutors: Map<string, string>,
  users: Map<string, string>,
  lastMessage: string,
): AgentConversationSummary {
  const phone = decryptOrPlaceholder(cipher, row.contactEncrypted, '')

  return {
    id: row.id,
    tutorId: row.tutorId,
    tutorName: row.tutorId ? (tutors.get(row.tutorId) ?? null) : null,
    // Com ficha, o número completo está a um clique na tela do tutor. Sem ficha, este é
    // o único lugar de onde a recepção pode tirá-lo para ligar de volta.
    contact: row.tutorId ? maskPhone(phone) : phone,
    status: row.status as AgentConversationSummary['status'],
    handoffReason: row.handoffReason as AgentConversationSummary['handoffReason'],
    assignedTo: row.assignedTo,
    assignedToName: row.assignedTo ? (users.get(row.assignedTo) ?? null) : null,
    turnCount: row.turnCount,
    lastTurnAt: row.lastTurnAt.toISOString(),
    waitingMinutes: Math.max(0, Math.floor((Date.now() - row.lastTurnAt.getTime()) / 60_000)),
    lastMessage,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Mídia não tem corpo guardado (AC-05): o que a tela mostra é o tipo. */
function contentOf(cipher: AgentCipher, payload: string, kind: string): string {
  const text = decryptOrPlaceholder(cipher, payload, '')
  if (text) return text
  const label = AGENT_INBOUND_LABELS[kind as keyof typeof AGENT_INBOUND_LABELS]
  return label && kind !== 'TEXT' ? `(${label})` : ''
}

/**
 * A última linha de cada conversa da página, numa consulta só.
 *
 * O caminho ingênuo — uma consulta por linha — custa vinte idas ao banco para desenhar
 * uma fila de vinte. Aqui vêm os turnos recentes das conversas da página e o mapa fica
 * com o mais novo de cada uma.
 */
async function lastTurnOf(
  tx: TenantTransaction,
  conversationIds: string[],
  cipher: AgentCipher,
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map()

  const rows = await tx.agentTurn.findMany({
    where: { conversationId: { in: conversationIds } },
    orderBy: { createdAt: 'desc' },
    select: { conversationId: true, contentEncrypted: true, kind: true },
    take: conversationIds.length * 4,
  })

  const found = new Map<string, string>()
  for (const row of rows) {
    if (found.has(row.conversationId)) continue
    found.set(row.conversationId, contentOf(cipher, row.contentEncrypted, row.kind))
  }
  return found
}

async function tutorNames(tx: TenantTransaction, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await tx.tutor.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true, socialName: true },
  })
  return new Map(rows.map((row) => [row.id, row.socialName ?? row.fullName]))
}

/**
 * O nome de quem assumiu, e de quem escreveu cada resposta.
 *
 * `users` é tabela global e `full_name` está em claro nela — resolver o nome aqui não
 * abre chave nenhuma, e é a mesma consulta que o painel de entregas faz.
 */
async function userNames(tx: TenantTransaction, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true },
  })
  return new Map(rows.map((row) => [row.id, row.fullName]))
}

/**
 * As fichas que casam com o telefone de uma conversa sem dono.
 *
 * Resolvidas **na leitura**, e não gravadas na conversa: o tutor cadastrado hoje precisa
 * aparecer na conversa de ontem, e é assim que a recepção fecha o caso do número
 * desconhecido sem ninguém reprocessar nada.
 */
async function findCandidates(
  tx: TenantTransaction,
  contactHash: string,
): Promise<AgentCandidate[]> {
  const rows = await tx.tutor.findMany({
    where: {
      status: { not: 'MERGED' },
      OR: [{ phoneHash: contactHash }, { phoneAltHash: contactHash }],
    },
    select: { id: true, fullName: true, socialName: true },
    take: 5,
  })
  return rows.map((row) => ({ tutorId: row.id, name: row.socialName ?? row.fullName }))
}
