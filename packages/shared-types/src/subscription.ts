import { z } from 'zod'
import { isValidCNPJ, isValidCPF, onlyDigits } from './br-documents.js'
import { TenantStatusSchema } from './identity.js'
import { PlanSchema } from './plans.js'

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

export const StartCheckoutSchema = z.strictObject({
  plan: SelfServicePlanSchema,
  method: BillingMethodSchema,
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
  graceDays: z.number().int(),
  subscription: z
    .object({
      /** O plano **contratado**, que pode ainda não estar em vigor (`PENDING`). */
      plan: PlanSchema,
      method: BillingMethodSchema,
      status: SubscriptionStatusSchema,
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
