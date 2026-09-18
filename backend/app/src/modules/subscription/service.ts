import { decryptPlatform, getMaintenancePrisma, withTenant } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  PLAN_CATALOG,
  PLAN_ORDER,
  planPriceCents,
  todayIn,
  type BillingCycle,
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
 *
 * **O ciclo — mensal ou anual — é escolhido aqui e não muda depois.** Ele decide o valor
 * de cada cobrança (`planPriceCents`) e, no anual, também as regras da troca de plano.
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
          cycle: row.cycle as BillingCycle,
          status: row.status,
          scheduledPlan: (row.scheduledPlan as Plan | null) ?? null,
          currentPeriodEndsAt: row.currentPeriodEndsAt?.toISOString() ?? null,
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
  const valueCents = planPriceCents(input.plan, input.cycle)
  if (valueCents === null) {
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
  const periodicidade = input.cycle === 'YEARLY' ? 'anual' : 'mensal'
  const description = `PetShop AI — plano ${definition.name} ${periodicidade} (${context.name})`
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
      valueCents,
      cycle: input.cycle,
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
      valueCents,
      cycle: input.cycle,
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
      cycle: input.cycle,
      status: 'PENDING' as const,
      // Recomeçar zera o que a assinatura anterior deixou: uma descida agendada e um
      // período pago são da assinatura que foi desfeita, não desta.
      scheduledPlan: null,
      currentPeriodEndsAt: null,
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
      after: { plan: input.plan, method: input.method, cycle: input.cycle },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })
  })

  return { paymentUrl: ids.paymentUrl }
}

/**
 * O sufixo que marca a cobrança avulsa da diferença de plano no `externalReference`.
 *
 * Existe para o webhook saber que **aquele** pagamento não renova nada: ele quita uma
 * subida no meio do ano, e estender o período por causa dele daria doze meses de brinde.
 * O prefixo continua sendo o id do estabelecimento, que é o que `localizar` procura.
 */
export const UPGRADE_REF = 'plan-upgrade'

/** O mês médio de um ano de 365 dias — a régua dos meses que faltam no ciclo anual. */
const MES_MEDIO_MS = Math.round((365 / 12) * 24 * 60 * 60 * 1000)

/**
 * Quantos meses ainda faltam no período pago, de 1 a 12.
 *
 * Arredonda **para cima**: quem está a vinte dias do fim paga a diferença de um mês, e
 * não de dois terços dele. Sem data de fim — linha anterior à contratação anual — conta
 * o ano inteiro, que é o pior caso para o cliente e o que ele reclamaria antes de pagar.
 */
function mesesRestantes(periodEndsAt: Date | null, now: Date): number {
  if (!periodEndsAt) return 12
  const faltam = Math.ceil((periodEndsAt.getTime() - now.getTime()) / MES_MEDIO_MS)
  return Math.min(12, Math.max(1, faltam))
}

/**
 * A troca de plano de quem já assina (e de quem ainda está no teste).
 *
 * **No teste, é só trocar**: nada foi cobrado, e a landing promete o teste "com todos os
 * recursos do plano escolhido".
 *
 * **No mensal, a troca vale na hora, para cima ou para baixo**: o valor muda no Asaas,
 * para a cobrança em aberto e as próximas, sem acerto proporcional de dias. É a regra mais
 * simples de explicar a um petshop, e a diferença de um mês é o valor de uma mensalidade.
 *
 * **No anual, os dois sentidos deixam de ser simétricos**, porque o ano já foi pago:
 *
 * - **subir** vale na hora e cobra a diferença dos meses que faltam, numa cobrança avulsa.
 *   Sem ela, assinar o Starter anual e subir para o Pro no dia seguinte daria onze meses
 *   de Pro pelo preço do Starter;
 * - **descer** fica agendado para a renovação. Não há estorno: o plano maior continua
 *   valendo até o fim do que foi pago, que é o que o dinheiro comprou.
 *
 * Escolher de novo o plano em vigor, com uma descida agendada, **desfaz o agendamento** —
 * é o único jeito de voltar atrás, e por isso não cai no "já está neste plano".
 */
export async function changePlan(
  actor: SubscriptionActor,
  input: ChangeSubscriptionPlanInput,
): Promise<SubscriptionView> {
  const tenant = await withTenant(actor.tenantId, (tx) =>
    tx.tenant.findFirst({
      select: {
        status: true,
        plan: true,
        name: true,
        subscription: true,
        settings: { select: { timezone: true } },
      },
    }),
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

  const cycle = row.cycle as BillingCycle
  const emVigor = row.plan as Plan
  const agendado = (row.scheduledPlan as Plan | null) ?? null

  if (emVigor === input.plan && tenant.plan === input.plan && !agendado) {
    throw invalidState(`O estabelecimento já está no plano ${PLAN_CATALOG[input.plan].name}`)
  }
  if (agendado === input.plan) {
    throw invalidState(
      `A mudança para o plano ${PLAN_CATALOG[input.plan].name} já está agendada para a renovação.`,
    )
  }

  const valor = planPriceCents(input.plan, cycle)
  if (valor === null) {
    throw invalidState('O Enterprise é sob consulta: fale com a equipe PetShop AI')
  }

  const provider = getBillingProviderPort()
  if (!provider.configured()) throw notConfigured()
  if (!row.providerSubscriptionId) {
    throw invalidState(
      'A assinatura ainda está sendo confirmada pelo Asaas. Tente de novo em alguns minutos.',
    )
  }

  if (cycle === 'MONTHLY') {
    await provider.updateSubscriptionValue(row.providerSubscriptionId, valor, {
      updatePendingPayments: true,
    })
    await gravarTroca(actor.tenantId, { plan: input.plan }, 'subscription.plan_changed', auditoria)
    await applyTenantPlan(actor.tenantId, input.plan, {
      reason: 'SUBSCRIPTION_PLAN_CHANGE',
      ...auditoria,
    })
    return getSubscription(actor.tenantId)
  }

  // Daqui para baixo é só o ciclo anual. O ano corrente já foi pago pelo que valia, então
  // a cobrança em aberto nunca muda de valor — `updatePendingPayments: false` em todos.
  const direcao = PLAN_ORDER.indexOf(input.plan) - PLAN_ORDER.indexOf(emVigor)

  if (direcao === 0) {
    await provider.updateSubscriptionValue(row.providerSubscriptionId, valor, {
      updatePendingPayments: false,
    })
    await gravarTroca(
      actor.tenantId,
      { scheduledPlan: null },
      'subscription.plan_schedule_canceled',
      auditoria,
    )
    return getSubscription(actor.tenantId)
  }

  if (direcao < 0) {
    await provider.updateSubscriptionValue(row.providerSubscriptionId, valor, {
      updatePendingPayments: false,
    })
    await gravarTroca(
      actor.tenantId,
      { scheduledPlan: input.plan },
      'subscription.plan_scheduled',
      auditoria,
    )
    return getSubscription(actor.tenantId)
  }

  if (!row.providerCustomerId) {
    throw invalidState(
      'A assinatura ainda está sendo confirmada pelo Asaas. Tente de novo em alguns minutos.',
    )
  }

  const meses = mesesRestantes(row.currentPeriodEndsAt, new Date())
  const anualAtual = planPriceCents(emVigor, 'YEARLY') ?? 0
  const diferenca = Math.round(((valor - anualAtual) / 12) * meses)
  const hoje = todayIn(tenant.settings?.timezone ?? DEFAULT_TIMEZONE)

  const cobranca = await provider.createCharge({
    customerId: row.providerCustomerId,
    valueCents: diferenca,
    dueDate: hoje,
    description: `PetShop AI — diferença do plano ${PLAN_CATALOG[emVigor].name} para o ${PLAN_CATALOG[input.plan].name}, ${meses} ${meses === 1 ? 'mês restante' : 'meses restantes'} (${tenant.name})`,
    externalReference: `${actor.tenantId}:${UPGRADE_REF}`,
  })

  // A renovação do ano que vem já sai pelo valor do plano novo.
  await provider.updateSubscriptionValue(row.providerSubscriptionId, valor, {
    updatePendingPayments: false,
  })
  await gravarTroca(
    actor.tenantId,
    {
      plan: input.plan,
      scheduledPlan: null,
      // A diferença é o que está em aberto agora; o link da renovação anterior já venceu.
      ...(cobranca.paymentUrl ? { paymentUrl: cobranca.paymentUrl } : {}),
    },
    'subscription.plan_upgraded',
    { ...auditoria, extra: { chargeCents: diferenca, months: meses } },
  )
  await applyTenantPlan(actor.tenantId, input.plan, {
    reason: 'SUBSCRIPTION_PLAN_CHANGE',
    ...auditoria,
  })

  return getSubscription(actor.tenantId)
}

/** A escrita da linha mais a trilha, que toda troca faz igual. */
async function gravarTroca(
  tenantId: string,
  data: { plan?: Plan; scheduledPlan?: Plan | null; paymentUrl?: string },
  action: string,
  auditoria: {
    actorUserId: string | null
    ipAddress: string | null
    userAgent: string | null
    extra?: Record<string, unknown>
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const before = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: { plan: true, scheduledPlan: true },
    })
    const after = await tx.tenantSubscription.update({ where: { tenantId }, data })
    await recordAudit(tx, {
      tenantId,
      action,
      entity: 'tenant_subscription',
      entityId: tenantId,
      actorUserId: auditoria.actorUserId,
      before: before ?? undefined,
      after: {
        plan: after.plan,
        scheduledPlan: after.scheduledPlan,
        cycle: after.cycle,
        ...(auditoria.extra ?? {}),
      },
      ipAddress: auditoria.ipAddress,
      userAgent: auditoria.userAgent,
    })
  })
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
