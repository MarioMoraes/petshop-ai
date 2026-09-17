import { timingSafeEqual } from 'node:crypto'
import { Prisma, getMaintenancePrisma, getPrisma, withTenant } from '@petshop/db'
import type { Plan, TenantStatus } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { applyTenantPlan } from '../../shared/plan.js'
import { transitionTenantStatus } from '../../shared/tenant-status.js'

/**
 * O que o Asaas conta sobre a assinatura (camada comercial, fatia 4).
 *
 * **É daqui, e só daqui, que o dinheiro muda o estado da conta.** A tela começa o
 * pagamento; quem diz que ele aconteceu é o evento. Por isso a rota recusa tudo sem o
 * token (`asaas-access-token`) e cada evento passa uma vez só, pela mesma
 * `webhook_events` do Clerk.
 *
 * **Como um evento chega ao estabelecimento.** O cliente do Asaas é a chave: toda cobrança
 * traz `payment.customer`. O cliente do PIX nós criamos e guardamos; o do cartão nasce no
 * checkout, e o evento do checkout (`checkout.customer`) é o que o devolve. Como segunda
 * chave, a assinatura (`payment.subscription`) e a referência externa, que é o id do
 * estabelecimento.
 */

const PROVIDER = 'asaas'

/** Status que o pagamento confirmado tira do bloqueio ou do atraso. */
const REATIVA: readonly TenantStatus[] = ['TRIAL', 'TRIAL_EXPIRED', 'PAST_DUE', 'SUSPENDED']

export function isValidAsaasToken(received: string | undefined): boolean {
  const expected = loadEnv().ASAAS_WEBHOOK_TOKEN
  // Sem token configurado, recusa tudo: um webhook aberto ativaria a assinatura de quem
  // quisesse, só de montar o JSON.
  if (!expected || !received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface AsaasPayment {
  id?: string
  customer?: string
  subscription?: string
  externalReference?: string
  invoiceUrl?: string
  dueDate?: string
}

interface AsaasCheckout {
  id?: string
  customer?: string
  externalReference?: string
}

export interface AsaasWebhookPayload {
  id?: string
  event?: string
  payment?: AsaasPayment
  checkout?: AsaasCheckout
  subscription?: { id?: string; customer?: string; externalReference?: string }
}

export type AsaasOutcome = 'PROCESSED' | 'IGNORED'

export async function applyAsaasWebhook(payload: AsaasWebhookPayload): Promise<AsaasOutcome> {
  const eventId = payload.id
  const event = payload.event
  if (!eventId || !event) return 'IGNORED'

  const prisma = getPrisma()
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: PROVIDER,
        externalEventId: eventId.slice(0, 80),
        eventType: event.slice(0, 60),
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.debug({ eventId, event }, 'evento do Asaas já processado')
      return 'IGNORED'
    }
    throw error
  }

  try {
    const outcome = await aplicar(event, payload)
    await prisma.webhookEvent.updateMany({
      where: { provider: PROVIDER, externalEventId: eventId.slice(0, 80) },
      data: { status: outcome, processedAt: new Date() },
    })
    return outcome
  } catch (error) {
    // Defeito nosso: a reserva sai, para a reentrega do Asaas achar o caminho livre.
    await prisma.webhookEvent.deleteMany({
      where: { provider: PROVIDER, externalEventId: eventId.slice(0, 80) },
    })
    throw error
  }
}

async function aplicar(event: string, payload: AsaasWebhookPayload): Promise<AsaasOutcome> {
  if (event.startsWith('CHECKOUT_')) return aplicarCheckout(event, payload.checkout ?? {})

  if (event === 'SUBSCRIPTION_DELETED' || event === 'SUBSCRIPTION_INACTIVATED') {
    const sub = payload.subscription ?? {}
    const row = await localizar({
      subscriptionId: sub.id,
      customerId: sub.customer,
      tenantId: sub.externalReference,
    })
    if (!row || (sub.id && row.providerSubscriptionId && row.providerSubscriptionId !== sub.id)) {
      return 'IGNORED'
    }
    await atualizar(row.tenantId, { status: 'CANCELED', paymentUrl: null }, 'subscription.canceled')
    return 'PROCESSED'
  }

  const payment = payload.payment
  if (!payment) return 'IGNORED'
  const row = await localizar({
    customerId: payment.customer,
    subscriptionId: payment.subscription,
    tenantId: payment.externalReference,
  })
  if (!row) {
    logger.warn({ event, customer: payment.customer }, 'cobrança do Asaas sem estabelecimento')
    return 'IGNORED'
  }
  // Cobrança de uma assinatura que não é mais a da linha — o PIX abandonado antes de
  // trocar para cartão. Pagar essa não pode ativar nada, e a tela nem a oferece mais.
  if (
    payment.subscription &&
    row.providerSubscriptionId &&
    payment.subscription !== row.providerSubscriptionId
  ) {
    logger.warn({ event, tenantId: row.tenantId }, 'cobrança de assinatura substituída')
    return 'IGNORED'
  }

  switch (event) {
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED':
      await ativar(row, { customerId: payment.customer, subscriptionId: payment.subscription })
      return 'PROCESSED'

    case 'PAYMENT_CREATED':
      // A mensalidade nova do PIX: o link dela é o que a tela oferece para pagar.
      if (row.method === 'PIX' && row.status !== 'PENDING' && payment.invoiceUrl) {
        await atualizar(row.tenantId, { paymentUrl: payment.invoiceUrl }, null)
        return 'PROCESSED'
      }
      return 'IGNORED'

    case 'PAYMENT_OVERDUE':
      if (row.status !== 'ACTIVE') return 'IGNORED'
      await atualizar(
        row.tenantId,
        {
          status: 'PAST_DUE',
          overdueSince: payment.dueDate ? new Date(`${payment.dueDate}T12:00:00Z`) : new Date(),
          paymentUrl: payment.invoiceUrl ?? row.paymentUrl,
        },
        'subscription.overdue',
      )
      await transitionTenantStatus(row.tenantId, {
        from: ['ACTIVE'],
        to: 'PAST_DUE',
        reason: 'PAYMENT_OVERDUE',
      })
      return 'PROCESSED'

    default:
      return 'IGNORED'
  }
}

async function aplicarCheckout(event: string, checkout: AsaasCheckout): Promise<AsaasOutcome> {
  if (!checkout.id) return 'IGNORED'
  const row = await localizar({ checkoutId: checkout.id })
  if (!row) return 'IGNORED'

  // O cliente do cartão nasce no checkout. Guardá-lo já no `CHECKOUT_CREATED` é o que faz
  // a primeira cobrança encontrar o estabelecimento, chegue ela antes ou depois do `PAID`.
  if (checkout.customer && checkout.customer !== row.providerCustomerId) {
    await atualizar(row.tenantId, { providerCustomerId: checkout.customer }, null)
  }

  if (event === 'CHECKOUT_PAID') {
    await ativar(row, { customerId: checkout.customer })
    return 'PROCESSED'
  }
  if (event === 'CHECKOUT_CANCELED' || event === 'CHECKOUT_EXPIRED') {
    // Desistência no cartão: a linha continua `PENDING`, mas sem link — a tela oferece
    // começar de novo em vez de mandar a pessoa para um checkout morto.
    if (row.status === 'PENDING') await atualizar(row.tenantId, { paymentUrl: null }, null)
    return 'PROCESSED'
  }
  return checkout.customer ? 'PROCESSED' : 'IGNORED'
}

type Linha = NonNullable<Awaited<ReturnType<typeof localizar>>>

async function localizar(chaves: {
  customerId?: string | undefined
  subscriptionId?: string | undefined
  checkoutId?: string | undefined
  tenantId?: string | undefined
}) {
  const ou: Prisma.TenantSubscriptionWhereInput[] = []
  if (chaves.customerId) ou.push({ providerCustomerId: chaves.customerId })
  if (chaves.subscriptionId) ou.push({ providerSubscriptionId: chaves.subscriptionId })
  if (chaves.checkoutId) ou.push({ providerCheckoutId: chaves.checkoutId })
  if (chaves.tenantId && /^[0-9a-f-]{36}$/i.test(chaves.tenantId))
    ou.push({ tenantId: chaves.tenantId })
  if (ou.length === 0) return null

  // Cross-tenant por natureza: o evento não diz de quem é antes de ser resolvido.
  return getMaintenancePrisma().tenantSubscription.findFirst({
    where: { provider: PROVIDER, OR: ou },
  })
}

async function ativar(
  row: Linha,
  ids: { customerId?: string | undefined; subscriptionId?: string | undefined },
): Promise<void> {
  await atualizar(
    row.tenantId,
    {
      status: 'ACTIVE',
      overdueSince: null,
      lastPaidAt: new Date(),
      paymentUrl: null,
      ...(ids.customerId && !row.providerCustomerId ? { providerCustomerId: ids.customerId } : {}),
      ...(ids.subscriptionId && !row.providerSubscriptionId
        ? { providerSubscriptionId: ids.subscriptionId }
        : {}),
    },
    row.status === 'ACTIVE' ? null : 'subscription.activated',
  )

  // O plano contratado entra em vigor com o dinheiro, e não com o clique.
  await applyTenantPlan(row.tenantId, row.plan as Plan, { reason: 'PAYMENT_CONFIRMED' })
  await transitionTenantStatus(row.tenantId, {
    from: REATIVA,
    to: 'ACTIVE',
    reason: 'PAYMENT_CONFIRMED',
  })
}

async function atualizar(
  tenantId: string,
  data: Prisma.TenantSubscriptionUpdateInput,
  auditAction: string | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const after = await tx.tenantSubscription.update({ where: { tenantId }, data })
    if (auditAction) {
      await recordAudit(tx, {
        tenantId,
        action: auditAction,
        entity: 'tenant_subscription',
        entityId: tenantId,
        after: { status: after.status, plan: after.plan, method: after.method },
      })
    }
  })
}
