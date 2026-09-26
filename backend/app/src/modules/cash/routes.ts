import {
  AppError,
  CashAdjustmentSchema,
  CashReportQuerySchema,
  CashSessionListQuerySchema,
  CloseCashSessionSchema,
  OpenCashSessionSchema,
  todayIn,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ActorContext } from './actor.js'
import { requirePermission, requireTenantContext } from './auth.js'
import { renderClosingHtml } from './closing-template.js'
import { PdfUnavailableError, renderPdf } from './pdf-port.js'
import { cashReport } from './reports.js'
import {
  adjustSession,
  cashAlerts,
  closeSession,
  closingReport,
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

  /**
   * O caixa esquecido aberto, para o sino da moldura. Rota à parte, e não
   * `/v1/cash/current`: o sino roda em toda navegação, e a sessão aberta viria com todos
   * os movimentos do dia e o nome de cada tutor, para o sino ler uma data.
   */
  app.get('/v1/cash/alerts', READ, async (request) => {
    return cashAlerts(actorFrom(request))
  })

  /**
   * Os relatórios do caixa — por período, por forma de pagamento e por tutor. Uma rota
   * só, porque são três recortes da mesma soma; `cash:read`, o mesmo de quem vê os
   * fechamentos, que já trazem o nome de cada tutor que pagou.
   */
  app.get('/v1/cash/reports', READ, async (request) => {
    const query = parseInput(CashReportQuerySchema, request.query)
    return cashReport(actorFrom(request), query)
  })

  app.get('/v1/cash/sessions', READ, async (request) => {
    const query = parseInput(CashSessionListQuerySchema, request.query)
    return listSessions(actorFrom(request), query)
  })

  app.get('/v1/cash/sessions/:id', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getSession(actorFrom(request), id)
  })

  /** O fechamento impresso — ou a conferência parcial, se o caixa ainda está aberto. */
  app.get('/v1/cash/sessions/:id/pdf', READ, async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const report = await closingReport(actorFrom(request), id)
    // O dia no fuso do petshop: o caixa aberto às 22h já é amanhã em UTC.
    const day = todayIn(report.timeZone, new Date(report.session.openedAt))
    return sendPdf(
      reply,
      renderClosingHtml({ ...report, generatedAt: new Date() }),
      `fechamento-do-caixa-${day}.pdf`,
    )
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

/** Em bytes, como os relatórios do estoque e do financeiro: o retrato de um instante. */
async function sendPdf(reply: FastifyReply, html: string, filename: string): Promise<FastifyReply> {
  let pdf: Buffer
  try {
    pdf = await renderPdf(html)
  } catch (error) {
    if (error instanceof PdfUnavailableError) {
      throw new AppError(
        'ERR_DOC_005',
        'A geração de PDF está indisponível no momento. Tente novamente em instantes.',
      )
    }
    throw error
  }

  return reply
    .type('application/pdf')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .header('cache-control', 'no-store')
    .send(pdf)
}
