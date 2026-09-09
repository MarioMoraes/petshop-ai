import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  BusinessHoursSchema,
  DEFAULT_BILLING_SETTINGS,
  DEFAULT_BUSINESS_HOURS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  type BusinessHours,
  type PortalFinanceResponse,
  type PortalPackage,
  type PortalPaymentInstructions,
  type PortalStatementEntry,
  type PortalStatementQuery,
  type PortalReceiptResponse,
  type PortalStatementResponse,
  type Weekday,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { notFound } from './errors.js'
import { logger } from '../../shared/logger.js'
import { getLedgerPort, type LedgerCaller } from './ledger-port.js'

/**
 * MOD-PORTAL-08 — a conta do tutor.
 *
 * Leitura pura, e por isso direto no banco, como os pets e os agendamentos: a regra da
 * fatia 2 vale inteira aqui. O extrato não decide nada — quem posta lançamento, quem
 * quita débito e quem calcula saldo é o `billing-ledger-service`, e o Portal só recorta
 * o que já está gravado. A única escrita do módulo é a emissão do PDF do recibo, e essa
 * vai por HTTP (`ledger-port.ts`).
 *
 * **A convenção de sinal é a da plataforma inteira** (RN-02 do MOD-LEDGER): negativo é
 * dívida, positivo é crédito. Nada aqui a inverte para "facilitar a tela"; quem exibe
 * usa `portalOwesCents` / `portalCreditCents`.
 *
 * **O que não é consultado**, e o motivo de a exclusão estar na consulta e não na
 * resposta (AC-02): `internal_notes_encrypted` nunca entra num `select` deste arquivo.
 * "Dei desconto porque ela reclamou" é anotação de balcão; filtrá-la depois de ler
 * significaria o texto ter atravessado o processo até uma linha de código que alguém
 * pode remover sem perceber.
 */

// ─── Painel financeiro ───────────────────────────────────────────────────────

/**
 * AC-01 e AC-04 — o saldo, o que está em aberto e os créditos de pacote.
 *
 * Uma resposta só, e não três: a tela é uma página de celular com três blocos, e o
 * tutor típico tem um saldo, zero ou um pacote e nenhuma pergunta a fazer depois disso.
 */
export async function readOwnFinance(
  tenantId: string,
  tutorId: string,
): Promise<PortalFinanceResponse> {
  return withTenant(tenantId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId },
      select: { id: true, balanceCents: true },
    })

    const [open, packages, instructions, settings] = await Promise.all([
      account ? openDebits(tx, tenantId, account.id) : emptyOpenDebits(),
      readOwnPackages(tx, tenantId, tutorId),
      readPaymentInstructions(tx, tenantId),
      tx.tenantSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    ])

    return {
      // RN-17 do MOD-LEDGER: conta que ainda não existe é tutor sem movimentação, e
      // isso é saldo zero — não é erro, e não é motivo para criar a conta agora.
      balanceCents: account ? Number(account.balanceCents) : 0,
      openDebitsCents: open.cents,
      oldestOpenDebitAt: open.oldest?.toISOString() ?? null,
      packages,
      howToPay: instructions,
      timezone: settings?.timezone ?? 'America/Sao_Paulo',
    }
  })
}

function emptyOpenDebits(): { cents: number; oldest: Date | null } {
  return { cents: 0, oldest: null }
}

/**
 * Quanto está em aberto, e desde quando.
 *
 * `amount_cents - settled_cents` e não o saldo: o saldo já desconta o crédito que
 * sobrou de um pagamento adiantado, e o tutor que pagou a mais continua com o débito de
 * ontem esperando alocação. São dois números diferentes e a tela mostra os dois.
 */
async function openDebits(
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
): Promise<{ cents: number; oldest: Date | null }> {
  const rows = await tx.$queryRaw<{ open_cents: bigint | null; oldest: Date | null }[]>`
    SELECT COALESCE(SUM(amount_cents - settled_cents), 0) AS open_cents,
           MIN(occurred_at)                               AS oldest
      FROM ledger_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND account_id = ${accountId}::uuid
       AND direction = 'DEBIT'
       AND status = 'POSTED'
       AND settled_cents < amount_cents
  `

  return { cents: Number(rows[0]?.open_cents ?? 0), oldest: rows[0]?.oldest ?? null }
}

/**
 * AC-04 — os pacotes com crédito de pé.
 *
 * Só `ACTIVE`: pacote esgotado, expirado ou suspenso não é saldo do tutor, e listá-lo
 * com "0 restantes" transformaria a seção num histórico de compras que ninguém pediu.
 * A razão da suspensão (`suspension_reason_encrypted`) fica de fora pelo mesmo motivo
 * da nota interna — pode citar óbito de pet ou situação familiar.
 */
async function readOwnPackages(
  tx: TenantTransaction,
  tenantId: string,
  tutorId: string,
): Promise<PortalPackage[]> {
  const rows = await tx.packagePurchase.findMany({
    where: { tutorId, status: 'ACTIVE' },
    orderBy: { expiresAt: 'asc' },
    select: {
      id: true,
      snapshot: true,
      petId: true,
      creditsTotal: true,
      creditsUsed: true,
      expiresAt: true,
    },
  })
  if (rows.length === 0) return []

  const petIds = rows.map((row) => row.petId).filter((id): id is string => id !== null)
  const pets =
    petIds.length > 0
      ? await tx.pet.findMany({ where: { id: { in: petIds } }, select: { id: true, name: true } })
      : []
  const petNames = new Map(pets.map((pet) => [pet.id, pet.name]))

  const warningDays = await warningWindowDays(tx, tenantId)
  const now = Date.now()

  return rows.map((row) => {
    const daysLeft = (row.expiresAt.getTime() - now) / 86_400_000

    return {
      id: row.id,
      // RN-05 do MOD-LEDGER: o nome é o do **ato da compra**. Renomear o pacote no
      // catálogo não pode mudar o que o tutor viu quando pagou.
      name: snapshotName(row.snapshot),
      petName: row.petId ? (petNames.get(row.petId) ?? null) : null,
      creditsTotal: row.creditsTotal,
      creditsRemaining: Math.max(row.creditsTotal - row.creditsUsed, 0),
      expiresAt: row.expiresAt.toISOString(),
      expiringSoon: daysLeft <= warningDays,
    }
  })
}

function snapshotName(snapshot: unknown): string {
  if (snapshot && typeof snapshot === 'object' && 'name' in snapshot) {
    const name = (snapshot as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) return name
  }
  return 'Pacote'
}

/**
 * A partir de quantos dias o vencimento vira aviso.
 *
 * É o **maior** dos avisos configurados pelo tenant (`[15, 3]` por padrão): o petshop
 * que avisa em D-15 já considera aquilo perto o bastante para incomodar o cliente, e o
 * Portal não tem por que ser mais discreto que a régua de mensagens.
 */
async function warningWindowDays(tx: TenantTransaction, tenantId: string): Promise<number> {
  const row = await tx.billingSettings.findUnique({
    where: { tenantId },
    select: { packageExpiryWarningDays: true },
  })
  const days = row?.packageExpiryWarningDays.length
    ? row.packageExpiryWarningDays
    : DEFAULT_BILLING_SETTINGS.packageExpiryWarningDays

  return Math.max(...days, 0)
}

/**
 * AC-05 — como pagar, já que não há como pagar aqui.
 *
 * Nada disto é dado do tutor: é a chave PIX, o telefone público e a grade de
 * funcionamento do estabelecimento. Ainda assim mora atrás de `finance:read_own`, e não
 * numa rota anônima, porque só faz sentido ao lado do saldo — solto, seria mais uma
 * superfície pública a manter.
 */
async function readPaymentInstructions(
  tx: TenantTransaction,
  tenantId: string,
): Promise<PortalPaymentInstructions> {
  const [billing, settings] = await Promise.all([
    tx.billingSettings.findUnique({ where: { tenantId }, select: { pixKey: true } }),
    tx.tenantSettings.findUnique({
      where: { tenantId },
      select: { publicPhone: true, publicWhatsapp: true, businessHours: true },
    }),
  ])

  return {
    pixKey: billing?.pixKey ?? null,
    phone: settings?.publicPhone ?? null,
    whatsapp: settings?.publicWhatsapp ?? null,
    hours: summarizeHours(parseHours(settings?.businessHours)),
  }
}

function parseHours(value: unknown): BusinessHours {
  const parsed = BusinessHoursSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_BUSINESS_HOURS
}

/**
 * A grade de sete dias em duas ou três linhas.
 *
 * Sete linhas num cartão de celular empurram o resto da tela para baixo, e seis delas
 * dizem a mesma coisa. Dias consecutivos com o mesmo horário viram uma faixa
 * ("Segunda a sexta"), e dia fechado simplesmente não aparece — quem procura horário de
 * atendimento quer saber quando **está** aberto.
 */
function summarizeHours(hours: BusinessHours): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = []
  let group: { first: Weekday; last: Weekday; value: string } | null = null

  const flush = () => {
    if (!group) return
    const label =
      group.first === group.last
        ? WEEKDAY_LABELS[group.first]
        : `${WEEKDAY_LABELS[group.first]} a ${WEEKDAY_LABELS[group.last].toLowerCase()}`
    lines.push({ label, value: group.value })
    group = null
  }

  for (const day of WEEKDAYS) {
    const entry = hours[day]
    if (entry.closed) {
      flush()
      continue
    }

    const value = `${entry.opensAt} às ${entry.closesAt}`
    if (group && group.value === value) {
      group.last = day
      continue
    }

    flush()
    group = { first: day, last: day, value }
  }

  flush()
  return lines
}

// ─── Extrato ─────────────────────────────────────────────────────────────────

interface StatementRow {
  id: string
  occurred_at: Date
  description: string
  signed_amount_cents: bigint
  category: string
  status: string
  pet_id: string | null
  source_type: string
  source_id: string | null
}

/**
 * AC-01 e AC-02 — os lançamentos, paginados.
 *
 * A ordem é por `occurred_at` decrescente e não por `posted_at`, pelo RN-23 do
 * MOD-LEDGER: o banho de sexta lançado na segunda pertence à sexta na leitura do
 * cliente. O desempate por `id` deixa a página determinística quando três serviços do
 * mesmo dia entram no mesmo instante.
 *
 * `signed_amount_cents` é coluna **gerada** pelo Postgres, e é ela que vai para a tela:
 * combinar `direction` com um valor absoluto no front seria repetir, no celular, uma
 * regra que o banco já garante.
 */
export async function readOwnStatement(
  tenantId: string,
  tutorId: string,
  query: PortalStatementQuery,
): Promise<PortalStatementResponse> {
  return withTenant(tenantId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId },
      select: { id: true, balanceCents: true },
    })

    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId },
      select: { timezone: true },
    })
    const timezone = settings?.timezone ?? 'America/Sao_Paulo'

    // Tutor sem movimentação: lista vazia e saldo zero, nunca 404 (AC-04 de
    // MOD-LEDGER-06). A conta nasce no primeiro lançamento, não na primeira consulta.
    if (!account) {
      return { entries: [], page: query.page, limit: query.limit, total: 0, balanceCents: 0, timezone }
    }

    const offset = (query.page - 1) * query.limit

    const [rows, totals] = await Promise.all([
      tx.$queryRaw<StatementRow[]>`
        SELECT id, occurred_at, description, signed_amount_cents, category::text,
               status::text, pet_id, source_type::text, source_id
          FROM ledger_entries
         WHERE tenant_id = ${tenantId}::uuid
           AND account_id = ${account.id}::uuid
         ORDER BY occurred_at DESC, id DESC
         LIMIT ${query.limit} OFFSET ${offset}
      `,
      tx.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count
          FROM ledger_entries
         WHERE tenant_id = ${tenantId}::uuid
           AND account_id = ${account.id}::uuid
      `,
    ])

    const petIds = [...new Set(rows.map((row) => row.pet_id).filter((id): id is string => !!id))]
    const pets =
      petIds.length > 0
        ? await tx.pet.findMany({ where: { id: { in: petIds } }, select: { id: true, name: true } })
        : []
    const petNames = new Map(pets.map((pet) => [pet.id, pet.name]))

    return {
      entries: rows.map((row) => toStatementEntry(row, petNames)),
      page: query.page,
      limit: query.limit,
      total: Number(totals[0]?.count ?? 0),
      balanceCents: Number(account.balanceCents),
      timezone,
    }
  })
}

function toStatementEntry(
  row: StatementRow,
  petNames: Map<string, string>,
): PortalStatementEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    description: row.description,
    amountCents: Number(row.signed_amount_cents),
    category: row.category,
    petName: row.pet_id ? (petNames.get(row.pet_id) ?? null) : null,
    // O lançamento estornado **aparece**, riscado. Sumir com ele faria o tutor que
    // reclamou de uma cobrança duvidar do extrato inteiro; é a mesma escolha do
    // atendimento anulado na linha do tempo do pet.
    reversed: row.status === 'REVERSED',
    paymentId: row.source_type === 'PAYMENT' ? row.source_id : null,
  }
}

// ─── Recibo ──────────────────────────────────────────────────────────────────

/**
 * AC-03 — o recibo em PDF do pagamento.
 *
 * Três passos, nesta ordem, e a ordem é a segurança do módulo:
 *
 * 1. **a posse é provada aqui**, com o recorte na consulta — pagamento de outra pessoa
 *    responde 404, exatamente como o que não existe (RN-03);
 * 2. só então a porta assina um contexto com `finance:read` e chama o ledger, que emite
 *    o PDF se ele ainda não existir;
 * 3. o acesso vai para `audit_logs`, como o §9 exige. Quem baixou o comprovante, e
 *    quando, é pergunta que se faz meses depois.
 *
 * A trilha é gravada **depois** da emissão, e não antes: registrar a intenção de quem
 * acabou levando um 502 encheria a tabela de acessos que não aconteceram.
 */
export async function readOwnReceipt(
  caller: LedgerCaller,
  actor: { actorUserId?: string | null; ipAddress?: string | undefined; userAgent?: string | undefined },
  tutorId: string,
  paymentId: string,
): Promise<PortalReceiptResponse> {
  const owns = await ownsPayment(caller.tenantId, tutorId, paymentId)
  if (!owns) throw notFound('Pagamento não encontrado')

  const receipt = await getLedgerPort().receipt(caller, paymentId)

  await withTenant(caller.tenantId, (tx) =>
    recordAudit(tx, {
      tenantId: caller.tenantId,
      actorUserId: actor.actorUserId ?? null,
      action: 'portal.receipt_accessed',
      entity: 'payment',
      entityId: paymentId,
      after: { number: receipt.number, status: receipt.status },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    }),
  ).catch((error: unknown) => {
    // O comprovante já foi entregue; falhar a resposta por causa da trilha faria o
    // tutor perder o recibo por um problema que não é dele. Fica o log.
    logger.error({ err: error, paymentId }, 'falha ao registrar o acesso ao recibo')
  })

  return receipt
}

/**
 * AC-02 de MOD-DOC-09 — o extrato do próprio tutor, em papel.
 *
 * O `tutorId` vem do `ownScope` do `service-kit`, nunca do corpo nem da URL: o filtro de
 * titularidade é injetado antes de a rota existir, e não conferido dentro dela. É o que
 * o AC pede em letra, e é o que impede que uma rota nova esqueça a checagem.
 *
 * A trilha registra o acesso, como no recibo: o extrato lista o que o tutor deve e a
 * quem, e é dado de conta corrente.
 */
export async function downloadOwnStatementPdf(
  caller: LedgerCaller,
  actor: { actorUserId?: string | null; ipAddress?: string | undefined; userAgent?: string | undefined },
  tutorId: string,
): Promise<{ bytes: Buffer; filename: string }> {
  const documento = await getLedgerPort().statementPdf(caller, tutorId)

  await withTenant(caller.tenantId, (tx) =>
    recordAudit(tx, {
      tenantId: caller.tenantId,
      actorUserId: actor.actorUserId ?? null,
      action: 'portal.statement_downloaded',
      entity: 'tutor',
      entityId: tutorId,
      after: { filename: documento.filename },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    }),
  ).catch((error: unknown) => {
    // A folha já foi montada; falhar a resposta por causa da trilha faria o tutor perder
    // o extrato por um problema que não é dele. Fica o log.
    logger.error({ err: error, tutorId }, 'falha ao registrar o download do extrato')
  })

  return documento
}

/**
 * O pagamento é **deste** tutor?
 *
 * Precede toda ida ao ledger pelo recibo. O recorte é `tutorId` na consulta e a
 * negativa é 404 (RN-03) — o pagamento de outra pessoa responde exatamente como o
 * pagamento que não existe.
 */
async function ownsPayment(
  tenantId: string,
  tutorId: string,
  paymentId: string,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, tutorId },
      select: { id: true },
    })
    return payment !== null
  })
}
