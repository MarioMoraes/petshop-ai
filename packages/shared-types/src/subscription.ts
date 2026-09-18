import { z } from 'zod'
import { isValidCNPJ, isValidCPF, onlyDigits } from './br-documents.js'
import { TenantStatusSchema } from './identity.js'
import { BillingCycleSchema, PlanPriceRowSchema, PlanSchema } from './plans.js'

/**
 * Camada comercial, fatia 4 — a assinatura do estabelecimento (Asaas).
 *
 * Cartão e PIX, e nada de boleto (decisão do produto de 2026-09-17). O Enterprise não se
 * assina pela tela: é "sob consulta" na landing, e quem o põe no estabelecimento é a
 * equipe PetShop AI, pelo console.
 */

export const BILLING_METHODS = ['CREDIT_CARD', 'PIX'] as const
export const BillingMethodSchema = z.enum(BILLING_METHODS)
export type BillingMethod = z.infer<typeof BillingMethodSchema>

export const BILLING_METHOD_LABELS: Record<BillingMethod, string> = {
  CREDIT_CARD: 'Cartão de crédito',
  PIX: 'PIX',
}

export const SubscriptionStatusSchema = z.enum(['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED'])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>

/** Os planos que a tela assina. */
export const SELF_SERVICE_PLANS = ['STARTER', 'PRO'] as const
export const SelfServicePlanSchema = z.enum(SELF_SERVICE_PLANS, {
  error: () => 'O Enterprise é sob consulta: fale com a equipe PetShop AI',
})

/**
 * O documento de quem paga. O Asaas não cadastra cliente sem CPF ou CNPJ, e o CNPJ do
 * wizard é opcional — então ele é pedido aqui, na hora em que passa a ser necessário.
 */
const DocumentoSchema = z
  .string()
  .transform(onlyDigits)
  .refine((digits) => (digits.length === 11 ? isValidCPF(digits) : isValidCNPJ(digits)), {
    message: 'Informe um CPF ou CNPJ válido',
  })

/**
 * O ciclo entra aqui, e não na troca de plano: ele é escolhido ao **começar** a
 * assinatura. O default mensal mantém de pé quem chama sem dizer nada — e é o ciclo que
 * o produto tinha antes de 2026-09-18.
 */
export const StartCheckoutSchema = z.strictObject({
  plan: SelfServicePlanSchema,
  method: BillingMethodSchema,
  cycle: BillingCycleSchema.default('MONTHLY'),
  cpfCnpj: DocumentoSchema,
})
export type StartCheckoutInput = z.output<typeof StartCheckoutSchema>

export const ChangeSubscriptionPlanSchema = z.strictObject({
  plan: SelfServicePlanSchema,
})
export type ChangeSubscriptionPlanInput = z.output<typeof ChangeSubscriptionPlanSchema>

export const SubscriptionViewSchema = z.object({
  tenantStatus: TenantStatusSchema,
  /** O plano em vigor — o que decide o que responde. */
  plan: PlanSchema,
  trialEndsAt: z.iso.datetime().nullable(),
  /** `false` sem `ASAAS_API_KEY`: a tela mostra o plano e não oferece pagar. */
  configured: z.boolean(),
  /**
   * A tabela de preços **de hoje** — o que custa assinar ou trocar de plano agora.
   *
   * Vem do servidor, e não do catálogo do pacote, porque a equipe da PetShop AI muda preço
   * pelo console. Não se confunde com `subscription.priceCents`, que é o que **este**
   * estabelecimento contratou e continua pagando.
   */
  prices: z.array(PlanPriceRowSchema),
  graceDays: z.number().int(),
  subscription: z
    .object({
      /** O plano **contratado**, que pode ainda não estar em vigor (`PENDING`). */
      plan: PlanSchema,
      method: BillingMethodSchema,
      cycle: BillingCycleSchema,
      status: SubscriptionStatusSchema,
      /**
       * O preço **contratado**, que não muda quando a tabela muda.
       *
       * É o grandfathering visível: quem assinou o Pro por R$ 299 continua lendo R$ 299 na
       * tela depois de um reajuste, porque é o que o Asaas continua cobrando dele.
       */
      priceCents: z.number().int().nullable(),
      /**
       * A descida de plano que espera a renovação (só no anual). Enquanto ela existe,
       * `plan` é o que está em vigor e este é o que entra quando o ano virar.
       */
      scheduledPlan: PlanSchema.nullable(),
      /** O que a descida agendada vai custar, fixado no dia em que foi agendada. */
      scheduledPriceCents: z.number().int().nullable(),
      /** O fim do período pago — a data em que a renovação cobra. */
      currentPeriodEndsAt: z.iso.datetime().nullable(),
      paymentUrl: z.string().nullable(),
      overdueSince: z.iso.datetime().nullable(),
      lastPaidAt: z.iso.datetime().nullable(),
    })
    .nullable(),
})
export type SubscriptionView = z.infer<typeof SubscriptionViewSchema>

export const CheckoutResponseSchema = z.object({
  /** Para onde a tela manda a pessoa: a fatura do PIX ou o checkout do cartão. */
  paymentUrl: z.string(),
})
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>
