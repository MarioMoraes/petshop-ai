import type { BillingCycle } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'
import { providerFailed } from './errors.js'

/**
 * A porta do provedor de pagamento — o Asaas (decisão do produto de 2026-09-17).
 *
 * Interface e implementação no mesmo arquivo, com `setBillingProviderPort` para os testes,
 * como as portas do MOD-PORTAL. O que o resto do módulo sabe do Asaas é esta lista de
 * métodos; o vocabulário dele (`billingType`, `cycle`, `invoiceUrl`) morre aqui.
 *
 * **Os dois caminhos de pagamento são diferentes de propósito.**
 *
 * - **PIX** é assinatura criada pela API: cliente, assinatura mensal, e o link é a fatura
 *   da primeira cobrança. Tudo documentado, tudo com a nossa referência.
 * - **Cartão** passa pelo **Checkout** do Asaas (`chargeTypes: RECURRENT`). A assinatura
 *   com cartão pela API exige o número do cartão no corpo, o que traria o dado do cartão
 *   para este servidor; no checkout ele é digitado na página do Asaas e nunca passa aqui.
 *   O preço disso é que o cliente e a assinatura nascem **lá** — e o webhook é que os
 *   devolve (ver `webhook.ts`).
 *
 * **O ciclo é o do Asaas (`MONTHLY`/`YEARLY`) porque é o mesmo vocabulário**, e não porque
 * um herda do outro: `BillingCycle` é nosso, e a tradução mora nas duas linhas que o
 * escrevem no corpo. O provedor cobra sozinho na periodicidade que a assinatura disser.
 *
 * Validado contra a documentação em 2026-09-17, e **não** contra o sandbox: o payload do
 * `CHECKOUT_PAID` não está documentado. Conferir no sandbox antes de produção.
 */

export interface PixSubscriptionRequest {
  customerId: string
  valueCents: number
  cycle: BillingCycle
  nextDueDate: string
  description: string
  externalReference: string
}

export interface CardCheckoutRequest {
  valueCents: number
  cycle: BillingCycle
  itemName: string
  description: string
  nextDueDate: string
  externalReference: string
  customer: { name: string; cpfCnpj: string; email?: string | undefined }
  successUrl: string
  cancelUrl: string
}

/**
 * A cobrança avulsa da diferença de plano, no ciclo anual.
 *
 * **Sempre PIX**, mesmo para quem assina no cartão: o cartão está guardado no Asaas, e
 * não aqui — cobrá-lo avulso exigiria o token que o Checkout não nos devolve. `UNDEFINED`
 * resolveria, mas abriria o boleto, que o produto não vende.
 */
export interface OneOffChargeRequest {
  customerId: string
  valueCents: number
  dueDate: string
  description: string
  externalReference: string
}

export interface BillingProviderPort {
  configured(): boolean
  createCustomer(input: {
    name: string
    cpfCnpj: string
    email?: string | undefined
    externalReference: string
  }): Promise<{ customerId: string }>
  createPixSubscription(
    input: PixSubscriptionRequest,
  ): Promise<{ subscriptionId: string; paymentUrl: string | null }>
  createCardCheckout(input: CardCheckoutRequest): Promise<{ checkoutId: string; url: string }>
  createCharge(
    input: OneOffChargeRequest,
  ): Promise<{ paymentId: string; paymentUrl: string | null }>
  /**
   * Troca de plano: o valor novo vale para as próximas cobranças.
   *
   * `updatePendingPayments` diz se a cobrança **já emitida** também muda. No mensal, muda
   * (a diferença de um mês é uma mensalidade); no anual, não — o ano corrente já foi pago
   * pelo que valia, e a diferença é cobrada à parte.
   */
  updateSubscriptionValue(
    subscriptionId: string,
    valueCents: number,
    options: { updatePendingPayments: boolean },
  ): Promise<void>
  cancelSubscription(subscriptionId: string): Promise<void>
}

const ASAAS_CYCLE: Record<BillingCycle, string> = { MONTHLY: 'MONTHLY', YEARLY: 'YEARLY' }

/**
 * A imagem do item do checkout. O Asaas a exige (`imageBase64` é obrigatório em `items`);
 * um quadrado de 64px na cor da marca, gerado uma vez, em vez de um arquivo no disco.
 */
const ITEM_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsGvi3xz2z2QE38JgBZbqeS0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFVdzQeZ0BZRAAAAAASUVORK5CYII='

const TIMEOUT_MS = 15_000

const reais = (cents: number) => Math.round(cents) / 100

function createAsaasPort(): BillingProviderPort {
  async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    const env = loadEnv()
    if (!env.ASAAS_API_KEY) throw providerFailed('Cobrança não configurada')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(`${env.ASAAS_API_URL}${path}`, {
        method,
        headers: {
          access_token: env.ASAAS_API_KEY,
          'content-type': 'application/json',
          'user-agent': 'petshop-ai',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        // O corpo do erro do Asaas vai para o log, e não para a tela: ele fala de campos
        // da API dele, que quem está assinando não tem como corrigir.
        logger.error({ status: response.status, path, body: text.slice(0, 500) }, 'Asaas recusou')
        throw providerFailed()
      }
      return (text ? JSON.parse(text) : {}) as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error({ path }, 'Asaas não respondeu a tempo')
        throw providerFailed()
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    configured: () => Boolean(loadEnv().ASAAS_API_KEY),

    async createCustomer(input) {
      const customer = await call<{ id: string }>('POST', '/customers', {
        name: input.name,
        cpfCnpj: input.cpfCnpj,
        ...(input.email ? { email: input.email } : {}),
        externalReference: input.externalReference,
      })
      return { customerId: customer.id }
    },

    async createPixSubscription(input) {
      const subscription = await call<{ id: string }>('POST', '/subscriptions', {
        customer: input.customerId,
        billingType: 'PIX',
        cycle: ASAAS_CYCLE[input.cycle],
        value: reais(input.valueCents),
        nextDueDate: input.nextDueDate,
        description: input.description,
        externalReference: input.externalReference,
      })
      // A primeira cobrança nasce junto com a assinatura; o link dela é o que a tela abre.
      const payments = await call<{ data: Array<{ invoiceUrl?: string }> }>(
        'GET',
        `/subscriptions/${subscription.id}/payments`,
      )
      return { subscriptionId: subscription.id, paymentUrl: payments.data[0]?.invoiceUrl ?? null }
    },

    async createCardCheckout(input) {
      const checkout = await call<{ id: string; link: string }>('POST', '/checkouts', {
        billingTypes: ['CREDIT_CARD'],
        chargeTypes: ['RECURRENT'],
        minutesToExpire: 60,
        externalReference: input.externalReference,
        callback: {
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          expiredUrl: input.cancelUrl,
        },
        items: [
          {
            name: input.itemName.slice(0, 30),
            description: input.description.slice(0, 150),
            imageBase64: ITEM_IMAGE_BASE64,
            quantity: 1,
            value: reais(input.valueCents),
          },
        ],
        customerData: {
          name: input.customer.name,
          cpfCnpj: input.customer.cpfCnpj,
          ...(input.customer.email ? { email: input.customer.email } : {}),
        },
        subscription: { cycle: ASAAS_CYCLE[input.cycle], nextDueDate: input.nextDueDate },
      })
      return { checkoutId: checkout.id, url: checkout.link }
    },

    async createCharge(input) {
      const payment = await call<{ id: string; invoiceUrl?: string }>('POST', '/payments', {
        customer: input.customerId,
        billingType: 'PIX',
        value: reais(input.valueCents),
        dueDate: input.dueDate,
        description: input.description.slice(0, 500),
        externalReference: input.externalReference,
      })
      return { paymentId: payment.id, paymentUrl: payment.invoiceUrl ?? null }
    },

    async updateSubscriptionValue(subscriptionId, valueCents, options) {
      await call('PUT', `/subscriptions/${subscriptionId}`, {
        value: reais(valueCents),
        updatePendingPayments: options.updatePendingPayments,
      })
    },

    async cancelSubscription(subscriptionId) {
      await call('DELETE', `/subscriptions/${subscriptionId}`)
    },
  }
}

let port: BillingProviderPort | null = null

export function getBillingProviderPort(): BillingProviderPort {
  port ??= createAsaasPort()
  return port
}

/** Para os testes. `null` volta à implementação real. */
export function setBillingProviderPort(next: BillingProviderPort | null): void {
  port = next
}
