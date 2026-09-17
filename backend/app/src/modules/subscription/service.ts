import { decryptPlatform, getMaintenancePrisma, withTenant } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  PLAN_CATALOG,
  todayIn,
  type ChangeSubscriptionPlanInput,
  type CheckoutResponse,
  type Plan,
  type StartCheckoutInput,
  type SubscriptionView,
  type TenantStatus,
} from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { applyTenantPlan } from '../../shared/plan.js'
import { getBillingProviderPort } from './asaas-port.js'
import { invalidState, notConfigured } from './errors.js'

/**
 * A assinatura do estabelecimento (camada comercial, fatia 4).
 *
 * **Escolher não é pagar.** O `POST` grava a linha em `PENDING` com o plano contratado e
 * devolve o link do pagamento; o plano e o estado da conta só mudam quando o Asaas
 * confirma, pelo webhook. Fechar a aba no meio do checkout não dá o Pro a ninguém, e não
 * tira o estabelecimento do teste.
 */

export interface SubscriptionActor {
  tenantId: string
  actorUserId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export async function getSubscription(tenantId: string): Promise<SubscriptionView> {
  const tenant = await withTenant(tenantId, (tx) =>
    tx.tenant.findFirst({
      select: { status: true, plan: true, trialEndsAt: true, subscription: true },
    }),
  )
  if (!tenant) throw invalidState('Estabelecimento não encontrado')

  const row = tenant.subscription
  return {
    tenantStatus: tenant.status as TenantStatus,
    plan: tenant.plan as Plan,
    trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
    configured: getBillingProviderPort().configured(),
    graceDays: loadEnv().BILLING_GRACE_DAYS,
    subscription: row
      ? {
          plan: row.plan as Plan,
          method: row.method,
          status: row.status,
          paymentUrl: row.paymentUrl,
          overdueSince: row.overdueSince?.toISOString() ?? null,
          lastPaidAt: row.lastPaidAt?.toISOString() ?? null,
        }
      : null,
  }
}

/**
 * Começa (ou recomeça) o pagamento.
 *
 * Quem já tem assinatura paga não passa por aqui: troca de plano é `changePlan`, e pagar a
 * mensalidade em aberto é o link que a tela já mostra. Recomeçar vale para o `PENDING` —
 * a pessoa desistiu do cartão e quer PIX, ou escolheu outro plano — e o que ficou para trás
 * no Asaas é cancelado, para não sobrar uma assinatura PIX gerando cobrança sem dono.
 */
export async function startCheckout(
  actor: SubscriptionActor,
  input: StartCheckoutInput,
): Promise<CheckoutResponse> {
  const provider = getBillingProviderPort()
  if (!provider.configured()) throw notConfigured()

  const context = await withTenant(actor.tenantId, (tx) =>
    tx.tenant.findFirst({
      select: {
        name: true,
        legalName: true,
        status: true,
        subscription: true,
        settings: { select: { timezone: true } },
      },
    }),
  )
  if (!context) throw invalidState('Estabelecimento não encontrado')
  if (context.status === 'TERMINATED') throw invalidState('Estabelecimento encerrado')

  const atual = context.subscription
  if (atual && atual.status !== 'PENDING' && atual.status !== 'CANCELED') {
    throw invalidState(
      'O estabelecimento já tem assinatura. Para mudar de plano, use a troca de plano.',
    )
  }

  const definition = PLAN_CATALOG[input.plan]
  if (definition.priceCents === null) {
    throw invalidState('O Enterprise é sob consulta: fale com a equipe PetShop AI')
  }

  // A pendência anterior que tinha assinatura criada no Asaas (PIX) é desfeita antes.
  // Falhar aqui não impede recomeçar: o pior caso é uma cobrança PIX vencendo sem
  // pagamento, que o webhook ignora por não ser mais a assinatura da linha.
  if (atual?.status === 'PENDING' && atual.providerSubscriptionId) {
    await provider.cancelSubscription(atual.providerSubscriptionId).catch((error: unknown) => {
      logger.warn(
        { err: error, tenantId: actor.tenantId },
        'pendência anterior não cancelada no Asaas',
      )
    })
  }

  const email = await actorEmail(actor.actorUserId)
  const nome = context.legalName ?? context.name
  const hoje = todayIn(context.settings?.timezone ?? DEFAULT_TIMEZONE)
  const description = `PetShop AI — plano ${definition.name} (${context.name})`
  const appUrl = loadEnv().APP_URL

  let ids: {
    customerId: string | null
    subscriptionId: string | null
    checkoutId: string | null
    paymentUrl: string
  }

  if (input.method === 'PIX') {
    const customerId =
      atual?.providerCustomerId ??
      (
        await provider.createCustomer({
          name: nome,
          cpfCnpj: input.cpfCnpj,
          email,
          externalReference: actor.tenantId,
        })
      ).customerId
    const created = await provider.createPixSubscription({
      customerId,
      valueCents: definition.priceCents,
      nextDueDate: hoje,
      description,
      externalReference: actor.tenantId,
    })
    if (!created.paymentUrl) {
      throw invalidState('O Asaas criou a assinatura sem link de pagamento. Tente de novo.')
    }
    ids = {
      customerId,
      subscriptionId: created.subscriptionId,
      checkoutId: null,
      paymentUrl: created.paymentUrl,
    }
  } else {
    const checkout = await provider.createCardCheckout({
      valueCents: definition.priceCents,
      itemName: `Plano ${definition.name}`,
      description,
      nextDueDate: hoje,
      externalReference: actor.tenantId,
      customer: { name: nome, cpfCnpj: input.cpfCnpj, email },
      successUrl: `${appUrl}/assinatura?retorno=pago`,
      cancelUrl: `${appUrl}/assinatura?retorno=cancelado`,
    })
    // O cliente do cartão nasce no Asaas, pelo checkout, e o webhook o devolve. Um cliente
    // de uma tentativa anterior por PIX fica na linha até lá.
    ids = {
      customerId: atual?.providerCustomerId ?? null,
      subscriptionId: null,
      checkoutId: checkout.checkoutId,
      paymentUrl: checkout.url,
    }
  }

  await withTenant(actor.tenantId, async (tx) => {
    const data = {
      plan: input.plan,
      method: input.method,
      status: 'PENDING' as const,
      providerCustomerId: ids.customerId,
      providerSubscriptionId: ids.subscriptionId,
      providerCheckoutId: ids.checkoutId,
      paymentUrl: ids.paymentUrl,
      overdueSince: null,
    }
    await tx.tenantSubscription.upsert({
      where: { tenantId: actor.tenantId },
      create: { tenantId: actor.tenantId, ...data },
      update: data,
    })
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      action: 'subscription.checkout_started',
      entity: 'tenant_subscription',
      entityId: actor.tenantId,
      actorUserId: actor.actorUserId ?? null,
      after: { plan: input.plan, method: input.method },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })
  })

  return { paymentUrl: ids.paymentUrl }
}

/**
 * A troca de plano de quem já assina (e de quem ainda está no teste).
 *
 * **No teste, é só trocar**: nada foi cobrado, e a landing promete o teste "com todos os
 * recursos do plano escolhido". Com assinatura paga, o valor muda no Asaas — para a
 * cobrança em aberto e as próximas — e o plano vale na hora, para cima ou para baixo. Não
 * há acerto proporcional de dias: é a regra mais simples de explicar a um petshop, e a
 * diferença de um mês é o valor de uma mensalidade.
 */
export async function changePlan(
  actor: SubscriptionActor,
  input: ChangeSubscriptionPlanInput,
): Promise<SubscriptionView> {
  const tenant = await withTenant(actor.tenantId, (tx) =>
    tx.tenant.findFirst({ select: { status: true, plan: true, subscription: true } }),
  )
  if (!tenant) throw invalidState('Estabelecimento não encontrado')

  const row = tenant.subscription
  const auditoria = {
    actorUserId: actor.actorUserId ?? null,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  }

  if (
    tenant.status === 'TRIAL' &&
    (!row || row.status === 'PENDING' || row.status === 'CANCELED')
  ) {
    await applyTenantPlan(actor.tenantId, input.plan, { reason: 'TRIAL_PLAN_CHANGE', ...auditoria })
    return getSubscription(actor.tenantId)
  }

  if (!row || (row.status !== 'ACTIVE' && row.status !== 'PAST_DUE')) {
    throw invalidState('Sem assinatura ativa. Assine um plano primeiro.')
  }
  if (row.plan === input.plan && tenant.plan === input.plan) {
    throw invalidState(`O estabelecimento já está no plano ${PLAN_CATALOG[input.plan].name}`)
  }

  const provider = getBillingProviderPort()
  if (!provider.configured()) throw notConfigured()
  if (!row.providerSubscriptionId) {
    throw invalidState(
      'A assinatura ainda está sendo confirmada pelo Asaas. Tente de novo em alguns minutos.',
    )
  }

  await provider.updateSubscriptionValue(
    row.providerSubscriptionId,
    PLAN_CATALOG[input.plan].priceCents ?? 0,
  )
  await withTenant(actor.tenantId, (tx) =>
    tx.tenantSubscription.update({
      where: { tenantId: actor.tenantId },
      data: { plan: input.plan },
    }),
  )
  await applyTenantPlan(actor.tenantId, input.plan, {
    reason: 'SUBSCRIPTION_PLAN_CHANGE',
    ...auditoria,
  })

  return getSubscription(actor.tenantId)
}

/** O e-mail de quem assina vai ao Asaas, que é quem manda a fatura e o recibo. */
async function actorEmail(userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined
  const user = await getMaintenancePrisma().user.findUnique({
    where: { id: userId },
    select: { emailEncrypted: true },
  })
  return user ? decryptPlatform(user.emailEncrypted) : undefined
}
