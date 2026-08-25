import { withTenant } from '@petshop/db'
import {
  CreateLedgerEntrySchema,
  CreatePackagePurchaseSchema,
  CreatePaymentSchema,
  CreateServicePackageSchema,
  CreditCheckQuerySchema,
  ListPaymentsQuerySchema,
  ReverseSchema,
  StatementQuerySchema,
  UpdateBillingSettingsSchema,
  UpdatePackagePurchaseSchema,
  UpdateServicePackageSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hasPermission, requirePermission, requireTenantContext } from '../../auth/context.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from './actor.js'
import { creditCheck } from './credit.js'
import { accountSummary, createManualEntry, getEntry, reverseEntry } from './entries.js'
import { toAccountResponse, toEntryResponse, toPackageResponse } from './mapper.js'
import {
  createPackage,
  findPurchase,
  listPackages,
  listTutorPackages,
  purchasePackage,
  updatePackage,
  updatePurchase,
} from './packages.js'
import { getPayment, listPayments, recordPayment, reversePayment } from './payments.js'
import { getReceiptForPayment } from './receipts.js'
import { receivablesByBucket } from './reconciliation.js'
import { getSettings, updateSettings } from './settings.js'
import { getStatement } from './statement.js'

/**
 * Rotas do financeiro (PRD financeiro_tutor_05 §5).
 *
 * A matriz do §9 tem cortes que valem a pena repetir aqui, porque são de negócio e
 * não de arquitetura:
 *
 * - **A recepção lança débito, mas não crédito.** Vender ração é rotina de balcão;
 *   conceder desconto é decisão de quem responde pelo caixa.
 * - **A recepção não estorna** (RN-25). O balcão registra, o gestor corrige.
 * - **O Super Admin não vê extrato de tutor.** Suporte a incidente financeiro se dá
 *   por `entryId` e log estruturado, nunca pela leitura da conta de alguém.
 */

const IdParamSchema = z.object({ id: z.uuid() })
const TutorParamSchema = z.object({ tutorId: z.uuid() })

function actorFrom(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId ?? undefined,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  }
}

const READ = { preHandler: requirePermission('finance:read') }
const WRITE = { preHandler: requirePermission('finance:create') }
const REFUND = { preHandler: requirePermission('finance:refund') }
const CONFIGURE = { preHandler: requirePermission('finance:configure') }

/**
 * AC-03 de MOD-LEDGER-06: o tutor vê valores, datas, descrições e recibos — mas
 * **não** vê `internal_notes`. Quem só tem `finance:read` sem `finance:read_own` é
 * staff; quem chega pelo Portal tem o contrário. A checagem é uma só, no servidor.
 */
function canSeeInternal(request: FastifyRequest): boolean {
  return hasPermission(request, 'finance:read')
}

export async function registerLedgerRoutes(app: FastifyInstance): Promise<void> {
  // ─── Conta e extrato ───────────────────────────────────────────────────────

  app.get('/v1/ledger/accounts/:tutorId', READ, async (request) => {
    const { tutorId } = parseInput(TutorParamSchema, request.params)
    const actor = actorFrom(request)

    const summary = await withTenant(actor.tenantId, (tx) =>
      accountSummary(tx, actor.tenantId, tutorId),
    )
    return toAccountResponse(tutorId, summary)
  })

  app.get('/v1/ledger/accounts/:tutorId/statement', READ, async (request) => {
    const { tutorId } = parseInput(TutorParamSchema, request.params)
    const query = parseInput(StatementQuerySchema, request.query)
    const includeInternal = canSeeInternal(request)

    const result = await getStatement(actorFrom(request), tutorId, query)

    return {
      // O extrato **nunca** decifra `internal_notes`, nem para o staff: decifrar N
      // linhas por página custaria uma operação de cripto por lançamento para um campo
      // que a tela não mostra. Quem quiser lê no detalhe do lançamento.
      data: result.rows.map((row) => toEntryResponse(row, { includeInternal, internalNotes: null })),
      total: result.total,
      page: result.page,
      limit: result.limit,
      summary: result.summary,
    }
  })

  /**
   * AC-01 a AC-03 de MOD-LEDGER-09 — a agenda pergunta antes de marcar.
   *
   * Sempre 200, mesmo bloqueando: quem transforma isto em recusa é o gate do
   * scheduling na hora de gravar. Aqui a agenda só quer saber o que exibir.
   */
  app.get('/v1/ledger/accounts/:tutorId/credit-check', READ, async (request) => {
    const { tutorId } = parseInput(TutorParamSchema, request.params)
    const query = parseInput(CreditCheckQuerySchema, request.query)
    return creditCheck(actorFrom(request), tutorId, query.amountCents)
  })

  // ─── Lançamentos ───────────────────────────────────────────────────────────

  app.post('/v1/ledger/entries', WRITE, async (request, reply) => {
    const input = parseInput(CreateLedgerEntrySchema, request.body)
    const actor = actorFrom(request)
    const result = await createManualEntry(actor, input, {
      canCredit: hasPermission(request, 'finance:credit'),
    })
    const entry = await getEntry(actor, result.entryId, canSeeInternal(request))

    // RN-04: a repetição devolve **200** com o mesmo recurso, não 201. O cliente
    // precisa poder distinguir "criei agora" de "já existia".
    return reply.status(result.repeated ? 200 : 201).send(entry)
  })

  app.get('/v1/ledger/entries/:id', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getEntry(actorFrom(request), id, canSeeInternal(request))
  })

  app.post('/v1/ledger/entries/:id/reverse', REFUND, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const { reason } = parseInput(ReverseSchema, request.body)
    return reverseEntry(actorFrom(request), id, reason)
  })

  // ─── Pagamentos ────────────────────────────────────────────────────────────

  app.post('/v1/payments', WRITE, async (request, reply) => {
    const input = parseInput(CreatePaymentSchema, request.body)
    const actor = actorFrom(request)
    const result = await recordPayment(actor, input)

    return reply.status(result.repeated ? 200 : 201).send(await getPayment(actor, result.paymentId))
  })

  app.get('/v1/payments', READ, async (request) => {
    const query = parseInput(ListPaymentsQuerySchema, request.query)
    return listPayments(actorFrom(request), query)
  })

  app.get('/v1/payments/:id', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getPayment(actorFrom(request), id)
  })

  /**
   * MOD-LEDGER-08 — o comprovante.
   *
   * Devolve URL assinada, não o PDF em stream: é o padrão que o álbum do MOD-PET já
   * estabeleceu, e fazer o serviço intermediar bytes de arquivo seria a exceção sem
   * motivo. `url` nula com status `PENDING` é resposta legítima — o recibo existe e tem
   * número, o arquivo é que ainda não.
   */
  app.get('/v1/payments/:id/receipt', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getReceiptForPayment(actorFrom(request), id)
  })

  app.post('/v1/payments/:id/reverse', REFUND, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const { reason } = parseInput(ReverseSchema, request.body)
    return reversePayment(actorFrom(request), id, reason)
  })

  // ─── Pacotes ───────────────────────────────────────────────────────────────

  app.get('/v1/packages', READ, async (request) => {
    const query = parseInput(
      z.object({ includeInactive: z.stringbool().default(false) }),
      request.query,
    )
    const rows = await listPackages(actorFrom(request), query.includeInactive)
    return { data: rows.map(toPackageResponse) }
  })

  app.post('/v1/packages', CONFIGURE, async (request, reply) => {
    const input = parseInput(CreateServicePackageSchema, request.body)
    const created = await createPackage(actorFrom(request), input)
    return reply.status(201).send({ id: created.id })
  })

  app.patch('/v1/packages/:id', CONFIGURE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(UpdateServicePackageSchema, request.body)
    const updated = await updatePackage(actorFrom(request), id, input)
    return { id: updated.id }
  })

  app.post('/v1/packages/:id/purchases', WRITE, async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(CreatePackagePurchaseSchema, request.body)

    const actor = actorFrom(request)
    const result = await purchasePackage(actor, id, input, {
      // Desconto na venda é decisão comercial, não de balcão.
      canOverridePrice: hasPermission(request, 'finance:credit'),
    })

    return reply.status(result.repeated ? 200 : 201).send(await findPurchase(actor, result.purchaseId))
  })

  app.get('/v1/tutors/:tutorId/packages', READ, async (request) => {
    const { tutorId } = parseInput(TutorParamSchema, request.params)
    return { data: await listTutorPackages(actorFrom(request), tutorId) }
  })

  app.patch('/v1/packages/purchases/:id', CONFIGURE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(UpdatePackagePurchaseSchema, request.body)
    return updatePurchase(actorFrom(request), id, input)
  })

  // ─── Relatórios e políticas ────────────────────────────────────────────────

  app.get('/v1/ledger/reports/receivables', CONFIGURE, async (request) => {
    return receivablesByBucket(actorFrom(request).tenantId)
  })

  app.get('/v1/billing-settings', READ, async (request) => {
    return getSettings(actorFrom(request))
  })

  app.patch('/v1/billing-settings', CONFIGURE, async (request) => {
    const input = parseInput(UpdateBillingSettingsSchema, request.body)
    return updateSettings(actorFrom(request), input)
  })
}

