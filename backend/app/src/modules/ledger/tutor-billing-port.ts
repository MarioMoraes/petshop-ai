import type { AsaasEnvironment } from '@petshop/shared-types'
import { ASAAS_BASE_URLS, asaasCall } from '../../shared/asaas-http.js'

/**
 * A porta para a conta do Asaas **do estabelecimento** — a cobrança online do tutor.
 *
 * Não é a mesma conta da assinatura (`subscription/asaas-port.ts`): lá a PetShop AI cobra
 * o petshop; aqui o petshop cobra o cliente dele, com a chave que cadastrou em
 * Integrações, e o dinheiro cai na conta dele. O HTTP é o mesmo (`shared/asaas-http.ts`);
 * o que muda é de quem é a chave, e por isso toda chamada a recebe.
 *
 * **Checkout, e não cobrança avulsa.** A cobrança avulsa com `billingType: UNDEFINED`
 * abre PIX, cartão **e boleto**, e o boleto ficou de fora por decisão de produto: leva
 * dias para compensar, e a baixa do tutor ficaria pendurada. O Checkout aceita a lista
 * exata de meios, e o cartão é digitado na página do Asaas — o número nunca passa aqui.
 *
 * O que o Asaas conta de volta chega pelo webhook que `registerWebhook` cadastra na conta
 * do petshop, com um token nosso (`webhook.ts` desta fatia).
 *
 * A lista de métodos é curta e nomeada, como toda porta do monólito: é ela que diz o que
 * este módulo faz em nome do petshop numa conta que não é nossa.
 */

export interface CheckoutRequest {
  valueCents: number
  itemName: string
  description: string
  /** O id da `tutor_charges`: é por ele que o webhook acha a cobrança. */
  externalReference: string
  minutesToExpire: number
  customer: { name: string; cpfCnpj: string | null; email: string | null; phone: string | null }
  /** Para onde a página do Asaas devolve o tutor depois de pagar (ou desistir). */
  returnUrl: string
}

export interface TutorBillingPort {
  /** `true` se a chave serve no ambiente dado; `false` se o Asaas a recusou. */
  validate(apiKey: string, environment: AsaasEnvironment): Promise<boolean>
  registerWebhook(
    apiKey: string,
    environment: AsaasEnvironment,
    input: { url: string; authToken: string; email: string | null },
  ): Promise<{ webhookId: string }>
  removeWebhook(apiKey: string, environment: AsaasEnvironment, webhookId: string): Promise<void>
  createCheckout(
    apiKey: string,
    environment: AsaasEnvironment,
    input: CheckoutRequest,
  ): Promise<{ checkoutId: string; url: string }>
}

/** Os eventos que dão baixa. O resto da vida da cobrança não muda o livro do petshop. */
const WEBHOOK_EVENTS = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'] as const

/**
 * A imagem do item do checkout. O Asaas a exige (`imageBase64` é obrigatório em `items`);
 * o mesmo quadrado neutro da assinatura, gerado uma vez, em vez de um arquivo no disco.
 */
const ITEM_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsGvi3xz2z2QE38JgBZbqeS0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFVdzQeZ0BZRAAAAAASUVORK5CYII='

const reais = (cents: number) => Math.round(cents) / 100

function credentials(apiKey: string, environment: AsaasEnvironment) {
  return { apiKey, baseUrl: ASAAS_BASE_URLS[environment] }
}

function createAsaasTutorBillingPort(): TutorBillingPort {
  return {
    async validate(apiKey, environment) {
      try {
        await asaasCall(credentials(apiKey, environment), 'GET', '/myAccount')
        return true
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 401) return false
        throw error
      }
    },

    async registerWebhook(apiKey, environment, input) {
      const webhook = await asaasCall<{ id: string }>(
        credentials(apiKey, environment),
        'POST',
        '/webhooks',
        {
          name: 'PetShop AI — baixa automática',
          url: input.url,
          ...(input.email ? { email: input.email } : {}),
          enabled: true,
          interrupted: false,
          // `v3` é a versão do payload; `SEQUENTIALLY` entrega na ordem, que é o que faz o
          // par CONFIRMED + RECEIVED chegar um depois do outro.
          apiVersion: 3,
          sendType: 'SEQUENTIALLY',
          authToken: input.authToken,
          events: WEBHOOK_EVENTS,
        },
      )
      return { webhookId: webhook.id }
    },

    async removeWebhook(apiKey, environment, webhookId) {
      await asaasCall(credentials(apiKey, environment), 'DELETE', `/webhooks/${webhookId}`)
    },

    async createCheckout(apiKey, environment, input) {
      const checkout = await asaasCall<{ id: string; link: string }>(
        credentials(apiKey, environment),
        'POST',
        '/checkouts',
        {
          billingTypes: ['PIX', 'CREDIT_CARD'],
          chargeTypes: ['DETACHED'],
          minutesToExpire: input.minutesToExpire,
          externalReference: input.externalReference,
          callback: {
            successUrl: input.returnUrl,
            cancelUrl: input.returnUrl,
            expiredUrl: input.returnUrl,
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
          // O Asaas pede na página o que faltar — o CPF, sobretudo, que nem todo tutor
          // tem cadastrado.
          customerData: {
            name: input.customer.name,
            ...(input.customer.cpfCnpj ? { cpfCnpj: input.customer.cpfCnpj } : {}),
            ...(input.customer.email ? { email: input.customer.email } : {}),
            ...(input.customer.phone ? { phone: input.customer.phone } : {}),
          },
        },
      )
      return { checkoutId: checkout.id, url: checkout.link }
    },
  }
}

let port: TutorBillingPort | null = null

export function getTutorBillingPort(): TutorBillingPort {
  port ??= createAsaasTutorBillingPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTutorBillingPort(next: TutorBillingPort | null): void {
  port = next
}
