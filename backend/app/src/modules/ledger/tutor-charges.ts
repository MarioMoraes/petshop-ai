import { randomUUID } from 'node:crypto'
import {
  decryptWithKey,
  getMaintenancePrisma,
  getTenantKey,
  withTenant,
  type TenantTransaction,
} from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  TUTOR_CHARGE_TTL_HOURS,
  formatBRL,
  type PaymentMethod,
  type TutorCharge,
  type TutorChargeCreated,
  type TutorChargeOrigin,
} from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { AsaasHttpError } from '../../shared/asaas-http.js'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { billingProviderFailed, onlineChargeUnavailable } from './errors.js'
import { getLedgerMessagingPort } from './messaging-port.js'
import { hashWebhookToken, loadCredentials, recordRejection } from './online-billing.js'
import { announcePayment, writePaymentInTx, type WrittenPayment } from './payments.js'
import { getTutorBillingPort } from './tutor-billing-port.js'

/**
 * A cobrança online do tutor: o link de pagamento, e a baixa que o Asaas manda de volta.
 *
 * **Quem cria**: o tutor, pelo "Pagar agora" do Portal/app (sempre o saldo devedor
 * inteiro, decidido aqui), ou a recepção, no Admin (o saldo, ou o valor que digitar).
 * **Quem paga**: só o webhook — a linha nasce `PENDING` e vira `PAID` com o pagamento
 * gravado na mesma transação, pelo mesmo `writePaymentInTx` do balcão. O recibo, o aviso
 * ao tutor, a alocação FIFO e a trilha são os de sempre; o que muda é o meio
 * (`PIX_ONLINE`/`CARD_ONLINE`) e que ninguém digitou nada.
 *
 * **O dinheiro manda, e não o estado da linha.** Uma cobrança vencida ou cancelada que o
 * tutor pagou mesmo assim — o link ficou aberto na aba — vira paga: o dinheiro caiu na
 * conta do petshop, e deixar de registrá-lo seria o livro mentir. Só a cobrança já paga é
 * ignorada, e é isso que torna inofensivo o par CONFIRMED + RECEIVED do mesmo pagamento.
 */

const TTL_MS = TUTOR_CHARGE_TTL_HOURS * 3_600_000

/**
 * A cobrança viva que ainda vale reaproveitar. Uma hora de folga: devolver um link que
 * vence em cinco minutos seria mandar o tutor para uma página que expira na mão dele.
 */
const REUSE_MARGIN_MS = 3_600_000

type ChargeRow = {
  id: string
  amountCents: bigint
  status: TutorCharge['status']
  origin: TutorChargeOrigin
  checkoutUrl: string
  expiresAt: Date
  paidAt: Date | null
  paymentId: string | null
  createdAt: Date
}

const CHARGE_SELECT = {
  id: true,
  amountCents: true,
  status: true,
  origin: true,
  checkoutUrl: true,
  expiresAt: true,
  paidAt: true,
  paymentId: true,
  createdAt: true,
} as const

function toApi(row: ChargeRow): TutorCharge {
  return {
    id: row.id,
    amountCents: Number(row.amountCents),
    status: row.status,
    origin: row.origin,
    url: row.checkoutUrl,
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    paymentId: row.paymentId,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Para onde a página do Asaas devolve o tutor: a conta dele no Portal do petshop. */
function returnUrl(slug: string): string {
  const env = loadEnv()
  const protocol = new URL(env.APP_URL).protocol
  return `${protocol}//${slug}.${env.APP_DOMAIN}/portal/financeiro`
}

function formatValidity(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(',', ' às')
}

export interface CreateChargeOptions {
  origin: TutorChargeOrigin
  /** Sem valor, o saldo devedor inteiro. */
  amountCents?: number | undefined
  /** Manda o link ao tutor pelo motor de mensagens (só o Admin pede). */
  send?: boolean
}

export async function createCharge(
  actor: ActorContext,
  tutorId: string,
  options: CreateChargeOptions,
): Promise<TutorChargeCreated> {
  const tenantId = actor.tenantId
  const now = new Date()

  const context = await withTenant(tenantId, async (tx) => {
    const credentials = await loadCredentials(tx, tenantId)
    if (!credentials) {
      throw onlineChargeUnavailable(
        'O pagamento online não está conectado. O Asaas do petshop é conectado em Configurações › Integrações.',
      )
    }

    const [tutor, account, tenant, settings] = await Promise.all([
      tx.tutor.findFirst({
        where: { id: tutorId, deletedAt: null },
        select: { fullName: true, socialName: true, cpfEncrypted: true },
      }),
      tx.ledgerAccount.findFirst({ where: { tutorId }, select: { balanceCents: true } }),
      tx.tenant.findFirstOrThrow({ select: { slug: true, name: true } }),
      tx.tenantSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    ])
    if (!tutor) throw onlineChargeUnavailable('Tutor não encontrado')

    // Negativo é dívida (RN-02): o que se cobra é o oposto do saldo.
    const owes = Math.max(0, -Number(account?.balanceCents ?? 0))
    const amountCents = options.amountCents ?? owes
    if (amountCents <= 0) {
      throw onlineChargeUnavailable('Não há valor em aberto para cobrar.')
    }

    const live = await tx.tutorCharge.findFirst({
      where: {
        tutorId,
        status: 'PENDING',
        amountCents: BigInt(amountCents),
        expiresAt: { gt: new Date(now.getTime() + REUSE_MARGIN_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: CHARGE_SELECT,
    })

    let cpf: string | null = null
    if (tutor.cpfEncrypted) {
      try {
        cpf = decryptWithKey(tutor.cpfEncrypted, await getTenantKey(tx, tenantId))
      } catch {
        cpf = null
      }
    }

    return {
      credentials,
      amountCents,
      live,
      tutorName: tutor.socialName ?? tutor.fullName,
      cpf,
      tenant,
      timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
    }
  })

  let charge: ChargeRow
  let created: boolean

  if (context.live) {
    // Duas abas, dois toques no botão, a recepção gerando de novo: o mesmo link. Dois
    // checkouts vivos pelo mesmo débito abririam a porta para o tutor pagar duas vezes.
    charge = context.live
    created = false
  } else {
    const chargeId = randomUUID()
    const expiresAt = new Date(now.getTime() + TTL_MS)

    let checkout: { checkoutId: string; url: string }
    try {
      checkout = await getTutorBillingPort().createCheckout(
        context.credentials.apiKey,
        context.credentials.environment,
        {
          valueCents: context.amountCents,
          itemName: context.tenant.name,
          description: `Conta de ${context.tutorName} no ${context.tenant.name}`,
          externalReference: chargeId,
          minutesToExpire: TUTOR_CHARGE_TTL_HOURS * 60,
          customer: { name: context.tutorName, cpfCnpj: context.cpf, email: null, phone: null },
          returnUrl: returnUrl(context.tenant.slug),
        },
      )
    } catch (error) {
      if (error instanceof AsaasHttpError && (error.status === 401 || error.status === 403)) {
        await recordRejection(tenantId, `O Asaas recusou a chave (${error.status})`)
        throw onlineChargeUnavailable(
          'O Asaas recusou a chave do petshop. O administrador precisa reconectá-la em Configurações › Integrações.',
        )
      }
      throw billingProviderFailed()
    }

    charge = await withTenant(
      tenantId,
      async (tx) => {
        const row = await tx.tutorCharge.create({
          data: {
            id: chargeId,
            tenantId,
            tutorId,
            amountCents: BigInt(context.amountCents),
            origin: options.origin,
            checkoutId: checkout.checkoutId,
            checkoutUrl: checkout.url,
            expiresAt,
            createdBy: actor.actorUserId ?? null,
          },
          select: CHARGE_SELECT,
        })
        await recordAudit(tx, {
          tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'ledger.tutor_charge_created',
          entity: 'tutor_charge',
          entityId: chargeId,
          after: { tutorId, amountCents: context.amountCents, origin: options.origin },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })
        return row
      },
      tenantOptions(actor),
    )
    created = true
  }

  let sent: boolean | null = null
  if (options.send) {
    sent = await getLedgerMessagingPort().sendChargeLink({
      tenantId,
      tutorId,
      chargeId: charge.id,
      variables: {
        'financeiro.valor_cobrado': formatBRL(Number(charge.amountCents)),
        'cobranca.link': charge.checkoutUrl,
        'cobranca.validade': formatValidity(charge.expiresAt, context.timezone),
      },
    })
  }

  return { charge: toApi(charge), created, sent }
}

export async function listCharges(tenantId: string, tutorId: string): Promise<TutorCharge[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.tutorCharge.findMany({
      where: { tutorId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: CHARGE_SELECT,
    }),
  )
  return rows.map(toApi)
}

// ─── A baixa ─────────────────────────────────────────────────────────────────

interface AsaasTutorPayment {
  id?: string
  externalReference?: string | null
  checkoutSession?: string | null
  billingType?: string
  confirmedDate?: string | null
  paymentDate?: string | null
}

export interface AsaasTutorWebhookPayload {
  event?: string
  payment?: AsaasTutorPayment
}

export type TutorWebhookOutcome = 'UNAUTHORIZED' | 'PROCESSED' | 'IGNORED'

const PAYING_EVENTS = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function methodOf(billingType: string | undefined): PaymentMethod {
  return billingType === 'CREDIT_CARD' || billingType === 'DEBIT_CARD'
    ? 'CARD_ONLINE'
    : 'PIX_ONLINE'
}

/** O tenant dono do token. É a maintenance que enxerga através da RLS para achá-lo. */
async function tenantByToken(token: string): Promise<string | null> {
  const row = await getMaintenancePrisma().billingSettings.findFirst({
    where: { asaasWebhookTokenHash: hashWebhookToken(token) },
    select: { tenantId: true },
  })
  return row?.tenantId ?? null
}

/** Trava a linha da cobrança: dois eventos do mesmo pagamento não gravam dois pagamentos. */
async function lockCharge(tx: TenantTransaction, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tutor_charges WHERE id = ${id}::uuid FOR UPDATE`
}

export async function applyTutorWebhook(
  token: string | undefined,
  payload: AsaasTutorWebhookPayload,
): Promise<TutorWebhookOutcome> {
  if (!token) return 'UNAUTHORIZED'
  const tenantId = await tenantByToken(token)
  if (!tenantId) return 'UNAUTHORIZED'

  if (!payload.event || !PAYING_EVENTS.has(payload.event)) return 'IGNORED'
  const payment = payload.payment ?? {}
  if (!payment.id) return 'IGNORED'

  const reference =
    payment.externalReference && UUID.test(payment.externalReference)
      ? payment.externalReference
      : null
  const checkoutId = payment.checkoutSession ?? null
  if (!reference && !checkoutId) {
    // Pagamento da conta do petshop que não nasceu de cobrança nossa — ele pode usar o
    // Asaas para outras coisas. Não é nosso, e não é erro.
    return 'IGNORED'
  }

  const actor: ActorContext = { tenantId }
  const result = await withTenant(tenantId, async (tx) => {
    const found = await tx.tutorCharge.findFirst({
      where: reference ? { id: reference } : { checkoutId: checkoutId! },
      select: { id: true },
    })
    if (!found) return null

    await lockCharge(tx, found.id)
    const charge = await tx.tutorCharge.findUniqueOrThrow({
      where: { id: found.id },
      select: { id: true, tutorId: true, amountCents: true, status: true },
    })
    if (charge.status === 'PAID') return null

    const receivedAt = new Date()
    const input = {
      tutorId: charge.tutorId,
      amountCents: Number(charge.amountCents),
      method: methodOf(payment.billingType),
      receivedAt: receivedAt.toISOString(),
      externalRef: payment.id!.slice(0, 120),
    }
    const written: WrittenPayment = await writePaymentInTx(tx, actor, input)

    await tx.tutorCharge.update({
      where: { id: charge.id },
      data: {
        status: 'PAID',
        paymentId: written.paymentId,
        asaasPaymentId: payment.id!.slice(0, 64),
        paidAt: receivedAt,
      },
    })

    if (charge.status !== 'PENDING') {
      logger.warn(
        { tenantId, chargeId: charge.id, status: charge.status },
        'cobrança fora do prazo foi paga mesmo assim — registrada',
      )
    }

    return { input, written }
  })

  if (!result) return 'IGNORED'
  await announcePayment(actor, result.input, result.written)
  return 'PROCESSED'
}

// ─── O vencimento ────────────────────────────────────────────────────────────

/**
 * Marca como vencidas as cobranças que passaram do prazo (`ledger.expire-tutor-charges`).
 *
 * É só a linha: o checkout no Asaas vence sozinho no mesmo prazo, e o pagamento que
 * chegar depois ainda é registrado pelo webhook. O que isto muda é a tela, que para de
 * oferecer um link morto.
 */
export async function expireCharges(now = new Date()): Promise<{ expired: number }> {
  const tenants = await getMaintenancePrisma().tutorCharge.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    select: { tenantId: true },
    distinct: ['tenantId'],
  })

  let expired = 0
  for (const { tenantId } of tenants) {
    try {
      const result = await withTenant(tenantId, (tx) =>
        tx.tutorCharge.updateMany({
          where: { status: 'PENDING', expiresAt: { lt: now } },
          data: { status: 'EXPIRED' },
        }),
      )
      expired += result.count
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'não foi possível vencer as cobranças do tenant')
    }
  }
  return { expired }
}
