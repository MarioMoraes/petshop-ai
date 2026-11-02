import {
  CheckoutResponseSchema,
  SubscriptionViewSchema,
  type ChangeSubscriptionCycleInput,
  type ChangeSubscriptionPlanInput,
  type StartCheckoutInput,
  BillingSettingsSchema,
  type UpdateBillingSettingsInput,
} from '@petshop/shared-types'
import { type Transport } from '../transport.js'

export function subscriptionEndpoints({ request }: Transport) {
  return {
    // ─── Assinatura do estabelecimento (camada comercial, fatia 4) ───────────

    getSubscription: () =>
      request({ method: 'GET', path: '/v1/subscription', schema: SubscriptionViewSchema }),

    /** Começa o pagamento e devolve o link — a fatura do PIX ou o checkout do cartão. */
    startSubscriptionCheckout: (input: StartCheckoutInput) =>
      request({
        method: 'POST',
        path: '/v1/subscription/checkout',
        body: input,
        schema: CheckoutResponseSchema,
      }),

    /** Mensal ↔ anual, na renovação. Pedir o ciclo atual desfaz a troca agendada. */
    changeSubscriptionCycle: (input: ChangeSubscriptionCycleInput) =>
      request({
        method: 'POST',
        path: '/v1/subscription/cycle',
        body: input,
        schema: SubscriptionViewSchema,
      }),

    changeSubscriptionPlan: (input: ChangeSubscriptionPlanInput) =>
      request({
        method: 'POST',
        path: '/v1/subscription/plan',
        body: input,
        schema: SubscriptionViewSchema,
      }),

    getBillingSettings: () =>
      request({
        method: 'GET',
        path: '/v1/billing-settings',
        schema: BillingSettingsSchema,
      }),

    updateBillingSettings: (input: UpdateBillingSettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/billing-settings',
        body: input,
        schema: BillingSettingsSchema,
      }),
  }
}
