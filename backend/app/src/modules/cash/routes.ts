import {
  CashAdjustmentSchema,
  CashSessionListQuerySchema,
  CloseCashSessionSchema,
  OpenCashSessionSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ActorContext } from './actor.js'
import { requirePermission, requireTenantContext } from './auth.js'
import {
  adjustSession,
  closeSession,
  currentSession,
  getSession,
  listSessions,
  openSession,
} from './sessions.js'
import { parseInput } from './validate.js'

/**
 * Rotas do MOD-CAIXA (PRD caixa_17 §5), todas sob `/v1/cash`.
 *
 * O prefixo está em `PLAN_GATES` (`CASH_REGISTER`, do Pro para cima). A venda avulsa e o
 * pagamento do tutor **não** passam por aqui: entram no caixa pela transação de quem os
 * grava, pelas portas `inventory/cash-port.ts` e `ledger/cash-port.ts`.
 */

const IdParamSchema = z.object({ id: z.uuid() })

function actorFrom(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId ?? undefined,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  }
}

const READ = { preHandler: requirePermission('cash:read') }
const OPERATE = { preHandler: requirePermission('cash:operate') }

export async function registerCashRoutes(app: FastifyInstance): Promise<void> {
  /** O caixa aberto agora, com os movimentos — ou `{ session: null }`. */
  app.get('/v1/cash/current', READ, async (request) => {
    return currentSession(actorFrom(request))
  })

  app.get('/v1/cash/sessions', READ, async (request) => {
    const query = parseInput(CashSessionListQuerySchema, request.query)
    return listSessions(actorFrom(request), query)
  })

  app.get('/v1/cash/sessions/:id', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getSession(actorFrom(request), id)
  })

  app.post('/v1/cash/sessions', OPERATE, async (request, reply) => {
    const input = parseInput(OpenCashSessionSchema, request.body ?? {})
    return reply.status(201).send(await openSession(actorFrom(request), input))
  })

  /** Sangria e suprimento, sempre no caixa aberto. */
  app.post('/v1/cash/adjustments', OPERATE, async (request, reply) => {
    const input = parseInput(CashAdjustmentSchema, request.body)
    return reply.status(201).send(await adjustSession(actorFrom(request), input))
  })

  app.post('/v1/cash/sessions/:id/close', OPERATE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(CloseCashSessionSchema, request.body)
    return closeSession(actorFrom(request), id, input)
  })
}
