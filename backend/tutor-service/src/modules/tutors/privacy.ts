import { withTenant } from '@petshop/db'
import type {
  CreateDeletionRequestInput,
  DeletionRequestListQuery,
  DeletionRequestListResponse,
  DeletionRequestResponse,
  ResolveDeletionRequestInput,
} from '@petshop/shared-types'
import { PORTAL_DELETION_RESPONSE_DAYS } from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { deletionRequestPending, notFound, terminalState } from '../../lib/errors.js'
import type { ActorContext } from './service.js'

/**
 * O pedido de exclusão de dados do titular (LGPD art. 18, V; AC-05 de MOD-PORTAL-09).
 *
 * **A decisão de desenho que organiza o arquivo: pedido e execução são coisas
 * separadas.** Marcar um pedido como atendido aqui não apaga nada — quem anonimiza é o
 * `POST /v1/tutors/:id/anonymize`, com as travas de débito aberto e agenda futura que ele
 * já tem. Fundir os dois faria um clique na fila apagar a ficha de quem deve dinheiro ao
 * petshop, contra a obrigação fiscal de guarda, e a fila é justamente a tela em que a
 * pressa mora.
 *
 * **Por que a tabela existe.** O AC-05 diz "registrado e encaminhado à equipe". Registro
 * sem fila que alguém veja é registro no vazio: o pedido cairia num `audit_logs` que
 * ninguém abre, o prazo do art. 19 correria sozinho, e o titular ficaria olhando para uma
 * tela que prometeu resposta. A linha é o que o sino da topbar conta.
 *
 * **Mora no tutor-service, e não no `portal-bff`.** O Portal é a superfície do cliente
 * final e o BFF só lê banco; esta tabela é escrita pelos dois lados — pelo titular no
 * Portal e pela recepção que registra o mesmo pedido quando o tutor liga — e lida por um
 * só, o Admin. Dois gravadores da mesma tabela é o que a porta do MOD-PORTAL-10 evitou
 * para o consentimento, e a razão vale igual aqui.
 */

/** O prazo do art. 19, II, congelado na criação do pedido. */
function dueDateFrom(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + PORTAL_DELETION_RESPONSE_DAYS * 24 * 60 * 60_000)
}

interface DeletionRow {
  id: string
  tutorId: string
  status: 'OPEN' | 'DONE' | 'REJECTED'
  reason: string | null
  createdAt: Date
  dueAt: Date
  respondedAt: Date | null
  resolution: string | null
  tutor: { fullName: string; socialName: string | null; balanceCents: number }
}

/**
 * A linha, com o nome que a equipe reconhece.
 *
 * RN-14 do MOD-TUTOR: o nome social é o nome exibido. Vale também numa fila de decisão
 * sobre dados pessoais — talvez sobretudo nela.
 */
function toResponse(row: DeletionRow): DeletionRequestResponse {
  return {
    id: row.id,
    tutorId: row.tutorId,
    tutorName: row.tutor.socialName ?? row.tutor.fullName,
    status: row.status,
    reason: row.reason,
    requestedAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
    resolution: row.resolution,
    balanceCents: row.tutor.balanceCents,
  }
}

const WITH_TUTOR = {
  tutor: { select: { fullName: true, socialName: true, balanceCents: true } },
} as const

/**
 * Registra o pedido.
 *
 * O 409 vem do índice único parcial `idx_deletion_requests_open_unico`, e a checagem
 * abaixo existe só para dar a mensagem certa antes de o banco recusar: o titular que
 * clica duas vezes merece ler "já está em análise", não um erro de restrição.
 *
 * Um pedido **já respondido** não impede o próximo. A lei não dá direito de uma vez só, e
 * a situação da ficha muda: a recusa de hoje é "você tem débito aberto", e daqui a um mês
 * pode não ser mais.
 */
export async function requestDeletion(
  actor: ActorContext,
  tutorId: string,
  input: CreateDeletionRequestInput,
): Promise<DeletionRequestResponse> {
  const now = new Date()

  const created = await withTenant(
    actor.tenantId,
    async (tx) => {
      const tutor = await tx.tutor.findFirst({
        where: { id: tutorId, deletedAt: null, anonymizedAt: null },
        select: { id: true, status: true },
      })
      if (!tutor) throw notFound()
      // Ficha mesclada não pede nada: os dados dela já vivem na de destino, e um pedido
      // aqui prometeria apagar o que não está mais neste id.
      if (tutor.status === 'MERGED') {
        throw terminalState('Este cadastro foi unificado com outro. O pedido é feito na ficha atual.')
      }

      const open = await tx.dataDeletionRequest.findFirst({
        where: { tutorId, status: 'OPEN' },
        select: { id: true },
      })
      if (open) throw deletionRequestPending()

      const row = await tx.dataDeletionRequest.create({
        data: {
          tenantId: actor.tenantId,
          tutorId,
          reason: input.reason ?? null,
          dueAt: dueDateFrom(now),
          // Prova de quem pediu, pelo mesmo motivo de `tutor_consents`: um pedido de
          // exclusão contestado depois precisa mostrar de onde veio.
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        },
        include: WITH_TUTOR,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.deletion_requested',
        entity: 'data_deletion_request',
        entityId: row.id,
        after: { tutorId, dueAt: row.dueAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return row
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  return toResponse(created)
}

/** A fila da equipe. Sem filtro de status, os abertos vêm primeiro e por prazo. */
export async function listDeletionRequests(
  tenantId: string,
  query: DeletionRequestListQuery,
): Promise<DeletionRequestListResponse> {
  const where = query.status ? { status: query.status } : {}

  return withTenant(tenantId, async (tx) => {
    const [rows, total] = await Promise.all([
      tx.dataDeletionRequest.findMany({
        where,
        include: WITH_TUTOR,
        /**
         * O aberto mais antigo no topo: o que vence primeiro é o que a equipe precisa
         * ver primeiro, e um pedido respondido não disputa espaço com um pendente.
         *
         * `status: 'asc'` funciona porque o Postgres ordena `enum` pela **ordem de
         * declaração**, e o tipo nasceu como `('OPEN', 'DONE', 'REJECTED')`. Reordenar os
         * valores na migration mudaria esta tela sem mudar uma linha deste arquivo.
         */
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.dataDeletionRequest.count({ where }),
    ])

    return {
      items: rows.map(toResponse),
      total,
      page: query.page,
      limit: query.limit,
    }
  })
}

/**
 * Quantos pedidos esperam decisão. Alimenta o sino da topbar.
 *
 * Rota própria pelo mesmo motivo do contador de leads do site: o sino roda em toda
 * navegação, e ler um número pela listagem traria vinte linhas com nome e saldo de tutor
 * para descobrir um inteiro.
 */
export async function countOpenDeletionRequests(tenantId: string): Promise<{ total: number }> {
  const total = await withTenant(tenantId, (tx) =>
    tx.dataDeletionRequest.count({ where: { status: 'OPEN' } }),
  )
  return { total }
}

/**
 * A resposta da equipe ao titular.
 *
 * `updateMany` com o status no `where` fecha a corrida de duas pessoas respondendo o
 * mesmo pedido em abas diferentes: a segunda não afeta linha nenhuma e recebe o 409, em
 * vez de sobrescrever em silêncio o que a primeira escreveu ao titular.
 */
export async function resolveDeletionRequest(
  actor: ActorContext,
  requestId: string,
  input: ResolveDeletionRequestInput,
): Promise<DeletionRequestResponse> {
  const row = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.dataDeletionRequest.findFirst({
        where: { id: requestId },
        select: { id: true, status: true, tutorId: true },
      })
      if (!before) throw notFound('Pedido não encontrado')
      if (before.status !== 'OPEN') {
        throw terminalState('Este pedido já foi respondido')
      }

      const { count } = await tx.dataDeletionRequest.updateMany({
        where: { id: requestId, status: 'OPEN' },
        data: {
          status: input.outcome,
          resolution: input.resolution,
          respondedAt: new Date(),
          respondedBy: actor.actorUserId ?? null,
        },
      })
      if (count !== 1) throw terminalState('Este pedido já foi respondido')

      const updated = await tx.dataDeletionRequest.findFirstOrThrow({
        where: { id: requestId },
        include: WITH_TUTOR,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.deletion_resolved',
        entity: 'data_deletion_request',
        entityId: requestId,
        before: { status: before.status },
        after: { status: input.outcome, tutorId: before.tutorId },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return updated
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  return toResponse(row)
}
