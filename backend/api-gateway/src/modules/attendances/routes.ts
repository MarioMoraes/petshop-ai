import {
  AddendumSchema,
  CreateAttendanceSchema,
  ListAttendancesQuerySchema,
  OperationalNoteSchema,
  TimelineQuerySchema,
  UpdateAttendanceSchema,
  VoidAttendanceSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { hasPermission, requirePermission, requireTenantContext } from '../records/auth.js'
import { recordAudit } from '../../shared/audit.js'
import { parseInput } from '../records/validate.js'
import { withTenant } from '@petshop/db'
import type { ActorContext } from '../records/actor.js'
import {
  addAddendum,
  addOperationalNote,
  createAttendance,
  getAttendance,
  listAttendances,
  updateAttendance,
  voidAttendance,
} from './service.js'
import { getClinicalSummary } from './summary.js'
import { getTimeline } from './timeline.js'

/**
 * Rotas do atendimento (PRD prontuario_04 §5).
 *
 * Não há `POST` que crie o atendimento no caminho normal — ele nasce do check-in e
 * do check-out da agenda, por evento. O `POST` que existe aqui é o de reparo, e a
 * mensagem de permissão diz isso, para que ninguém o descubra por acidente e passe a
 * lançar atendimento à mão em paralelo ao balcão.
 *
 * O corte de permissão do §9 tem uma sutileza que vale ler: **anular é `record:void`,
 * só do administrador**, enquanto corrigir é `record:write_notes` (de quem atendeu).
 * A diferença é que a anulação estorna dinheiro no ledger — e quem responde por isso
 * é quem responde pelo caixa, não quem deu o banho.
 */

interface IdParams {
  id: string
}

interface PetParams {
  petId: string
}

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export async function registerAttendanceRoutes(app: FastifyInstance): Promise<void> {
  // ─── Linha do tempo e resumo (MOD-PRONT-02 e 11) ───────────────────────────

  /**
   * AC-02: o filtro por papel é **servidor**. `record:read` abre a linha inteira;
   * quem entra por `record:read_alerts` recebe o recorte operacional — serviços,
   * segurança e fotos, sem laudo nem diagnóstico. Esconder no cliente seria mandar
   * o dado clínico para o navegador do banhista e pedir que ele não olhasse.
   */
  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/timeline',
    { preHandler: requirePermission('record:read_alerts') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(TimelineQuerySchema, request.query)
      const full = hasPermission(request, 'record:read')

      const page = await getTimeline(auth.tenantId, request.params.petId, { full, query })

      // §9: **toda leitura** do prontuário completo entra na trilha. É log de acesso,
      // não de escrita — sigilo profissional se prova mostrando quem olhou.
      if (full) {
        await withTenant(auth.tenantId, (tx) =>
          recordAudit(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId ?? null,
            action: 'medical_record.viewed',
            entity: 'pet',
            entityId: request.params.petId,
            after: { entries: page.entries.length },
            ipAddress: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          }),
        )
      }

      return page
    },
  )

  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/summary',
    { preHandler: requirePermission('record:read_summary') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getClinicalSummary(auth.tenantId, request.params.petId)
    },
  )

  // ─── Atendimento (MOD-PRONT-01) ────────────────────────────────────────────

  app.get(
    '/v1/attendances',
    { preHandler: requirePermission('record:read_summary') },
    async (request) => {
      const query = parseInput(ListAttendancesQuerySchema, request.query)
      return listAttendances(actorOf(request), query)
    },
  )

  app.get<{ Params: IdParams }>(
    '/v1/attendances/:id',
    { preHandler: requirePermission('record:read_summary') },
    async (request) => getAttendance(actorOf(request), request.params.id),
  )

  /** Caminho de reparo — ver o docblock de `createAttendance`. */
  app.post(
    '/v1/attendances',
    {
      preHandler: requirePermission(
        'record:write',
        'Lançar atendimento à mão é do administrador ou do veterinário — o registro normal nasce do check-out',
      ),
    },
    async (request, reply) => {
      const input = parseInput(CreateAttendanceSchema, request.body)
      const attendance = await createAttendance(actorOf(request), input)
      return reply.status(201).send(attendance)
    },
  )

  /** AC-01 do §09: dentro das 24h, o autor corrige. Fora delas, 409 e adendo. */
  app.patch<{ Params: IdParams }>(
    '/v1/attendances/:id',
    { preHandler: requirePermission('record:write_notes') },
    async (request) => {
      const patch = parseInput(UpdateAttendanceSchema, request.body)
      return updateAttendance(
        actorOf(request),
        request.params.id,
        patch,
        hasPermission(request, 'record:write'),
      )
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/attendances/:id/addendum',
    { preHandler: requirePermission('record:write_notes') },
    async (request, reply) => {
      const input = parseInput(AddendumSchema, request.body)
      const attendance = await addAddendum(
        actorOf(request),
        request.params.id,
        input,
        hasPermission(request, 'record:write'),
      )
      return reply.status(201).send(attendance)
    },
  )

  /** MOD-PRONT-10: a nota de quem está com o pet na mão, enquanto o atende. */
  app.post<{ Params: IdParams }>(
    '/v1/attendances/:id/notes',
    { preHandler: requirePermission('record:write_notes') },
    async (request, reply) => {
      const input = parseInput(OperationalNoteSchema, request.body)
      const attendance = await addOperationalNote(actorOf(request), request.params.id, input)
      return reply.status(201).send(attendance)
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/attendances/:id/void',
    {
      preHandler: requirePermission(
        'record:void',
        'Anular atendimento é do administrador — a anulação estorna o débito',
      ),
    },
    async (request) => {
      const input = parseInput(VoidAttendanceSchema, request.body)
      return voidAttendance(actorOf(request), request.params.id, input)
    },
  )
}
