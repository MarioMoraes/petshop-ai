import { withTenant } from '@petshop/db'
import {
  CreateLedgerEntrySchema,
  CreatePackagePurchaseSchema,
  CreatePaymentSchema,
  CreateServicePackageSchema,
  AccountsReceivableQuerySchema,
  CashflowQuerySchema,
  CreditCheckQuerySchema,
  ReceiptsByDayQuerySchema,
  ListPaymentsQuerySchema,
  ReverseSchema,
  StatementQuerySchema,
  UpdateBillingSettingsSchema,
  UpdatePackagePurchaseSchema,
  UpdateServicePackageSchema,
  todayIn,
  zonedDayRange,
  FinanceIndicatorsQuerySchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hasPermission, requirePermission, requireTenantContext } from './auth.js'
import { documentUnavailable } from './errors.js'
import { PdfUnavailableError, renderPdf } from './pdf-port.js'
import { parseInput } from './validate.js'
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
import { financeIndicators } from './indicators.js'
import { cashflowByMethod, receivablesByBucket } from './reconciliation.js'
import { accountsReceivableReport, receiptsByDayReport } from './reports.js'
import { renderAccountsReceivableHtml, renderReceiptsByDayHtml } from './report-template.js'
import { getSettings, updateSettings } from './settings.js'
import { getStatement, statementDocument, statementFilename } from './statement.js'
import { renderStatementHtml } from './statement-template.js'

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

/**
 * O intervalo do extrato em papel — só as duas datas.
 *
 * Sem `page` nem `limit`: paginar um PDF é a folha mentir sobre o que contém. Quando o
 * período não cabe no teto, a própria folha diz quantos lançamentos ficaram de fora.
 */
const StatementPeriodSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
})
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
   * AC-01 de MOD-DOC-09 — o extrato em papel.
   *
   * **Desce em bytes, e não por URL assinada**, ao contrário do recibo: o extrato não
   * entra em `documents` e não vai ao bucket (AC-04 e RN-01). Ele descreve o presente, e
   * um arquivo guardado hoje contradiz o sistema amanhã — não há endereço a assinar
   * porque não há arquivo a guardar.
   *
   * Mesma permissão do extrato em tela: quem pode ler a conta pode imprimi-la.
   */
  app.get('/v1/ledger/accounts/:tutorId/statement/pdf', READ, async (request, reply) => {
    const { tutorId } = parseInput(TutorParamSchema, request.params)
    const period = parseInput(StatementPeriodSchema, request.query)

    const data = await statementDocument(actorFrom(request), tutorId, period)

    return sendPdf(reply, renderStatementHtml(data), statementFilename(period))
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

  /** Prazo de recebimento, adesão a pacotes e crédito vencido — a faixa do Início. */
  app.get('/v1/ledger/reports/indicators', CONFIGURE, async (request) => {
    const query = parseInput(FinanceIndicatorsQuerySchema, request.query)
    return financeIndicators(actorFrom(request).tenantId, query.days)
  })

  /**
   * Entradas por período e forma de pagamento (§5).
   *
   * Sem `from`/`to`, o dia de hoje — que é o recorte do painel. O fuso é o do
   * estabelecimento: "hoje" para um petshop em Rio Branco não é o mesmo "hoje" do
   * servidor em UTC, e o caixa do dia fecharia três horas cedo.
   */
  app.get('/v1/ledger/reports/cashflow', CONFIGURE, async (request) => {
    const query = parseInput(CashflowQuerySchema, request.query)
    const actor = actorFrom(request)

    const { from, to } = await resolvePeriod(actor.tenantId, query)
    return cashflowByMethod(actor.tenantId, from, to)
  })

  /**
   * MOD-COBRANCA — os dois relatórios imprimíveis do menu Cobrança.
   *
   * Cada um responde em duas formas, e a diferença está só no `/pdf` do fim: a rota
   * nua devolve JSON, que é o que a tela desenha, e a `/pdf` devolve o documento. O
   * corpo é o mesmo objeto nos dois casos, montado uma vez — foi para não ter duas
   * verdades sobre o mesmo relatório que o cálculo saiu do template.
   *
   * O PDF vai **em bytes**, e não como URL assinada de bucket, ao contrário do recibo
   * do MOD-LEDGER-08. A diferença é a natureza do documento: o recibo é peça contábil
   * com número, retenção de cinco anos e endereço próprio; o relatório é o retrato de
   * um instante, parametrizado por data, que não se guarda — arquivar cada clique de
   * "Baixar PDF" encheria o bucket de folhas que ninguém vai reabrir.
   */
  app.get('/v1/ledger/reports/accounts-receivable', CONFIGURE, async (request) => {
    const query = parseInput(AccountsReceivableQuerySchema, request.query)
    return accountsReceivableReport(actorFrom(request).tenantId, query)
  })

  app.get('/v1/ledger/reports/accounts-receivable/pdf', CONFIGURE, async (request, reply) => {
    const query = parseInput(AccountsReceivableQuerySchema, request.query)
    const report = await accountsReceivableReport(actorFrom(request).tenantId, query)

    return sendPdf(reply, renderAccountsReceivableHtml(report), `contas-a-receber-${report.asOf}.pdf`)
  })

  app.get('/v1/ledger/reports/receipts-by-day', CONFIGURE, async (request) => {
    const query = parseInput(ReceiptsByDayQuerySchema, request.query)
    return receiptsByDayReport(actorFrom(request).tenantId, query)
  })

  app.get('/v1/ledger/reports/receipts-by-day/pdf', CONFIGURE, async (request, reply) => {
    const query = parseInput(ReceiptsByDayQuerySchema, request.query)
    const report = await receiptsByDayReport(actorFrom(request).tenantId, query)

    return sendPdf(
      reply,
      renderReceiptsByDayHtml(report),
      `contas-recebidas-${report.from}-a-${report.to}.pdf`,
    )
  })

  app.get('/v1/billing-settings', READ, async (request) => {
    return getSettings(actorFrom(request))
  })

  app.patch('/v1/billing-settings', CONFIGURE, async (request) => {
    const input = parseInput(UpdateBillingSettingsSchema, request.body)
    return updateSettings(actorFrom(request), input)
  })
}


/**
 * O período pedido, ou o dia de hoje — sempre **no fuso do estabelecimento**.
 *
 * `tenant_settings.timezone` é a única fonte de "que dia é hoje" que faz sentido aqui:
 * o servidor roda em UTC e o dono do petshop não. Em São Paulo, o dia começa às 03:00
 * UTC — montar a janela como `00:00Z`–`23:59Z` joga três horas de movimento noturno
 * para o dia errado, e é o erro que parece certo.
 */
async function resolvePeriod(
  tenantId: string,
  query: { from?: string; to?: string },
): Promise<{ from: Date; to: Date }> {
  const timezone = await withTenant(tenantId, async (tx) => {
    const settings = await tx.tenantSettings.findFirst({
      where: { tenantId },
      select: { timezone: true },
    })
    return settings?.timezone ?? 'America/Sao_Paulo'
  })

  if (query.from || query.to) {
    return {
      from: query.from ? zonedDayRange(query.from, timezone).from : new Date(0),
      to: query.to ? zonedDayRange(query.to, timezone).to : new Date(),
    }
  }

  return zonedDayRange(todayIn(timezone), timezone)
}


/**
 * HTML vira PDF e desce como anexo.
 *
 * `attachment` e não `inline`: quem clicou em "Baixar PDF" quer o arquivo, e o visor do
 * navegador engoliria o nome que a rota escolheu — que é justamente o que torna a pasta
 * de downloads legível depois de três relatórios.
 *
 * `PdfUnavailableError` é o Gotenberg fora do ar, e vira 503 em vez de 500: o relatório
 * continua inteiro em tela, é só o papel que não sai agora.
 */
async function sendPdf(reply: FastifyReply, html: string, filename: string): Promise<FastifyReply> {
  let pdf: Buffer
  try {
    pdf = await renderPdf(html)
  } catch (error) {
    if (error instanceof PdfUnavailableError) throw documentUnavailable()
    throw error
  }

  return reply
    .type('application/pdf')
    .header('content-disposition', `attachment; filename="${filename}"`)
    // O relatório é o retrato de um instante e leva o telefone de quem deve: nem o
    // navegador nem nenhum intermediário tem por que guardar uma cópia.
    .header('cache-control', 'no-store')
    .send(pdf)
}
