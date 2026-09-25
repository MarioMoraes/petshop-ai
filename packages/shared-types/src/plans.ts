import { z } from 'zod'

/**
 * O catálogo dos planos — a definição única.
 *
 * Três lugares descrevem planos: a landing page (`frontend/landing-page`), a etapa de
 * plano do onboarding e o backend, que aplica os limites. Até 2026-09-17 cada um tinha
 * a sua divisão, e a landing prometia uma que o produto não seguia. Agora o onboarding e
 * o backend leem daqui, e a landing — HTML estático, que não importa TypeScript — é
 * conferida contra este arquivo por `frontend/src/lib/landing-plans.test.ts`.
 *
 * Mudou preço, teto ou recurso de um plano? Muda aqui e na landing, na mesma mudança: o
 * teste aponta a diferença.
 */

export const PLANS = ['STARTER', 'PRO', 'ENTERPRISE'] as const
export const PlanSchema = z.enum(PLANS)
export type Plan = z.infer<typeof PlanSchema>

/**
 * Mensal ou anual — o ciclo de cobrança (decisão do produto de 2026-09-18).
 *
 * O anual **não é outro plano**: teto de usuários, cota de fotos e recursos são os do
 * plano escolhido, e o que muda é só o preço e a periodicidade da cobrança. Por isso ele
 * mora aqui, ao lado do preço, e não numa segunda tabela de produtos.
 *
 * O ciclo é escolhido ao **começar** a assinatura e não muda depois: trocar de ciclo é
 * trocar de assinatura no Asaas, com o dinheiro de um ano mudando de lugar, e não uma
 * edição da que está correndo.
 */
export const BILLING_CYCLES = ['MONTHLY', 'YEARLY'] as const
export const BillingCycleSchema = z.enum(BILLING_CYCLES)
export type BillingCycle = z.infer<typeof BillingCycleSchema>

export const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  MONTHLY: 'Mensal',
  YEARLY: 'Anual',
}

/** O desconto do anual, em pontos percentuais — o número que a landing anuncia. */
export const ANNUAL_DISCOUNT_PERCENT = 20

/**
 * O preço anual que corresponde a uma mensalidade: doze meses menos o desconto,
 * **arredondado para real inteiro para baixo**.
 *
 * Existe porque `149 × 12 × 0,8` dá R$ 1.430,40, e preço de tabela com quarenta centavos
 * não se anuncia. O catálogo guarda o número escolhido e `plans.test.ts` o confere contra
 * esta função: um preço mensal novo sem o anual correspondente derruba o teste.
 */
export function yearlyPriceOf(monthlyCents: number): number {
  return Math.floor((monthlyCents * 12 * (100 - ANNUAL_DISCOUNT_PERCENT)) / 10_000) * 100
}

/**
 * O que um plano libera além do anterior. A operação (agenda, tutores, pets, prontuário,
 * financeiro, PDFs, e-mail) não tem chave: está em todos os planos e não se bloqueia.
 */
export const PLAN_FEATURES = [
  'WHATSAPP',
  'CAMPAIGNS',
  'PORTAL',
  'SITE',
  'TAXI',
  'INVENTORY',
  'CASH_REGISTER',
  'AI_AGENT',
  'AI_PERSONA',
  'AI_QUALITY',
] as const
export const PlanFeatureSchema = z.enum(PLAN_FEATURES)
export type PlanFeature = z.infer<typeof PlanFeatureSchema>

/** O nome de cada recurso, para a tela que avisa em que plano ele está. */
export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  WHATSAPP: 'WhatsApp com mensagens automáticas',
  CAMPAIGNS: 'Campanhas, aniversário e régua de cobrança',
  PORTAL: 'Portal e aplicativo do tutor, com agendamento online',
  SITE: 'Site do estabelecimento com domínio próprio',
  TAXI: 'Taxi Dog',
  INVENTORY: 'Controle de estoque com lote e validade',
  CASH_REGISTER: 'Caixa do dia com abertura e fechamento',
  AI_AGENT: 'Agente de IA no WhatsApp',
  AI_PERSONA: 'Persona e tom de voz próprios do agente',
  AI_QUALITY: 'Painel de qualidade do atendimento',
}

export interface PlanDefinition {
  key: Plan
  name: string
  pitch: string
  /** Mensalidade por estabelecimento. `null` é "sob consulta". */
  priceCents: number | null
  /**
   * O ano inteiro pago de uma vez, já com o desconto — e **não** doze mensalidades.
   * `null` acompanha `priceCents`: quem é sob consulta é sob consulta nos dois ciclos.
   */
  priceYearlyCents: number | null
  /** RN-11 de MOD-IDENT: teto de usuários, verificado no convite e no aceite. `null` é ilimitado. */
  seats: number | null
  /** AC-03 de MOD-PET-06: a cota conta fotos, não bytes. `null` é ilimitado. */
  photoQuota: number | null
  /** Os recursos que este plano **acrescenta** ao anterior. */
  adds: PlanFeature[]
  /** O título da lista de destaques: "Inclui" ou "Tudo do Starter, mais". */
  includesLead: string
  /** Os destaques do cartão, na ordem e com as palavras da landing. */
  includes: string[]
}

export const PLAN_CATALOG: Record<Plan, PlanDefinition> = {
  STARTER: {
    key: 'STARTER',
    name: 'Starter',
    pitch: 'Para organizar a operação e sair do caderno e da planilha.',
    priceCents: 14_900,
    priceYearlyCents: 143_000,
    seats: 5,
    photoQuota: 500,
    adds: [],
    includesLead: 'Inclui',
    includes: [
      'Agenda do dia e Mural',
      'Tutores, pets e fotos',
      'Prontuário e receituário',
      'Financeiro, pacotes e recibos',
      'Relatórios e documentos em PDF',
      'Lembretes por e-mail',
      'Importação de planilhas e do sistema anterior',
    ],
  },
  PRO: {
    key: 'PRO',
    name: 'Pro',
    pitch: 'Para equipes que querem o cliente perto: WhatsApp com IA, portal, app e site.',
    priceCents: 29_900,
    priceYearlyCents: 287_000,
    seats: 15,
    photoQuota: 5_000,
    adds: [
      'WHATSAPP',
      'CAMPAIGNS',
      'PORTAL',
      'SITE',
      'TAXI',
      'INVENTORY',
      'CASH_REGISTER',
      'AI_AGENT',
    ],
    includesLead: 'Tudo do Starter, mais',
    includes: [
      'WhatsApp com mensagens automáticas',
      'Campanhas, aniversário e cobrança',
      'Portal do Tutor com agendamento online',
      'Aplicativo do tutor para iOS e Android',
      'Site do estabelecimento',
      'Taxi Dog',
      'Estoque com lote e validade',
      'Caixa do dia com abertura e fechamento',
      'Agente de IA no WhatsApp',
      'Suporte por WhatsApp',
    ],
  },
  ENTERPRISE: {
    key: 'ENTERPRISE',
    name: 'Enterprise',
    pitch: 'Para redes e operações grandes, com o agente de IA sob medida.',
    priceCents: null,
    priceYearlyCents: null,
    seats: null,
    photoQuota: null,
    adds: ['AI_PERSONA', 'AI_QUALITY'],
    includesLead: 'Tudo do Pro, mais',
    includes: [
      'Persona e tom de voz próprios do agente',
      'Painel de qualidade do atendimento',
      'Usuários ilimitados',
      'Suporte prioritário e implantação assistida',
    ],
  },
}

/** Os planos do menor para o maior: um plano contém tudo o que os anteriores liberam. */
export const PLAN_ORDER: readonly Plan[] = PLANS

/** O menor plano que libera o recurso. */
export function minimumPlanFor(feature: PlanFeature): Plan {
  const plan = PLAN_ORDER.find((candidate) => PLAN_CATALOG[candidate].adds.includes(feature))
  // Inalcançável enquanto o teste de cobertura do catálogo estiver verde.
  if (!plan) throw new Error(`Recurso sem plano: ${feature}`)
  return plan
}

export function planIncludes(plan: Plan, feature: PlanFeature): boolean {
  return PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(minimumPlanFor(feature))
}

/** Todos os recursos liberados no plano, somando os dos planos anteriores. */
export function planFeatures(plan: Plan): PlanFeature[] {
  return PLAN_FEATURES.filter((feature) => planIncludes(plan, feature))
}

/**
 * O valor de **uma cobrança** no ciclo escolhido: a mensalidade ou o ano inteiro.
 *
 * É por aqui que preço e ciclo andam juntos — quem multiplica por doze à mão em algum
 * outro lugar está reinventando o desconto.
 */
export function planPriceCents(plan: Plan, cycle: BillingCycle): number | null {
  const definition = PLAN_CATALOG[plan]
  return cycle === 'YEARLY' ? definition.priceYearlyCents : definition.priceCents
}

/** Quanto o anual economiza num ano, para a tela e a landing dizerem o número. */
export function annualSavingsCents(plan: Plan): number | null {
  const { priceCents, priceYearlyCents } = PLAN_CATALOG[plan]
  if (priceCents === null || priceYearlyCents === null) return null
  return priceCents * 12 - priceYearlyCents
}

/**
 * O desconto que um par de preços representa, em pontos percentuais inteiros.
 *
 * `ANNUAL_DISCOUNT_PERCENT` é o desconto **proposto** — o que o console preenche sozinho
 * e o que o HTML da landing traz de reserva. O par que está valendo pode ser outro: o
 * console deixa a anuidade editável de propósito, porque "dois meses grátis" é 16,7% e
 * não 20%. Toda tela que anuncia o desconto calcula daqui, e assim nunca anuncia um
 * número que os preços ao lado desmentem.
 *
 * `null` quando não há desconto a anunciar (anual igual ou maior que doze mensalidades).
 */
export function annualDiscountPercentOf(monthlyCents: number, yearlyCents: number): number | null {
  if (monthlyCents <= 0 || yearlyCents <= 0) return null
  const percent = Math.round((1 - yearlyCents / (monthlyCents * 12)) * 100)
  return percent > 0 ? percent : null
}

/**
 * O preço **efetivo** de um plano, que pode não ser o do catálogo.
 *
 * Desde 2026-09-18 a equipe da PetShop AI muda preço pelo console, e o que ela grava vive
 * em `plan_prices`. O catálogo acima deixou de ser a última palavra e passou a ser o
 * **padrão**: o valor de partida de uma instalação nova e a reserva da landing, que é
 * HTML estático e precisa de um número no arquivo mesmo quando a API não responde.
 *
 * Quem resolve o efetivo é o backend (`shared/plan-prices.ts`); estes tipos são só a forma
 * que ele atravessa a rede.
 */
export const PlanPriceRowSchema = z.object({
  plan: PlanSchema,
  monthlyCents: z.number().int().nullable(),
  yearlyCents: z.number().int().nullable(),
})
export type PlanPriceRow = z.output<typeof PlanPriceRowSchema>

/**
 * O preço **padrão** de cada plano, na forma que atravessa a rede.
 *
 * É a reserva de quem precisa mostrar preço sem alcançar a tabela: a landing tem a dela
 * no próprio HTML, e as telas que rodam no servidor do Next usam esta — a resposta de
 * `/public/v1/plans` fora do ar deixa a tela com o padrão do código, nunca sem número.
 */
export function catalogPlanPriceRows(): PlanPriceRow[] {
  return PLAN_ORDER.map((plan) => ({
    plan,
    monthlyCents: PLAN_CATALOG[plan].priceCents,
    yearlyCents: PLAN_CATALOG[plan].priceYearlyCents,
  }))
}

/** O que a landing lê: só plano e preço, sem nada da administração. */
export const PublicPlanPricesSchema = z.object({ items: z.array(PlanPriceRowSchema) })
export type PublicPlanPrices = z.output<typeof PublicPlanPricesSchema>

/** O que o console lê: o efetivo, o padrão do código e quem mexeu por último. */
export const PlanPriceAdminRowSchema = PlanPriceRowSchema.extend({
  name: z.string(),
  /** O do catálogo. Igual ao efetivo quando ninguém mexeu. */
  defaultMonthlyCents: z.number().int().nullable(),
  defaultYearlyCents: z.number().int().nullable(),
  updatedAt: z.iso.datetime().nullable(),
})
export type PlanPriceAdminRow = z.output<typeof PlanPriceAdminRowSchema>

export const PlanPricesResponseSchema = z.object({ items: z.array(PlanPriceAdminRowSchema) })
export type PlanPricesResponse = z.output<typeof PlanPricesResponseSchema>

/**
 * O `?plan=` que a landing manda para o cadastro (`/sign-up?plan=pro`). Em minúsculas
 * porque é URL; qualquer valor fora do catálogo vale como ausente, e o wizard segue com
 * o padrão.
 */
export function parsePlanParam(value: unknown): Plan | null {
  if (typeof value !== 'string') return null
  const parsed = PlanSchema.safeParse(value.trim().toUpperCase())
  return parsed.success ? parsed.data : null
}

export const PLAN_SEAT_LIMITS: Record<Plan, number | null> = {
  STARTER: PLAN_CATALOG.STARTER.seats,
  PRO: PLAN_CATALOG.PRO.seats,
  ENTERPRISE: PLAN_CATALOG.ENTERPRISE.seats,
}

export const PHOTO_QUOTA_BY_PLAN: Record<Plan, number | null> = {
  STARTER: PLAN_CATALOG.STARTER.photoQuota,
  PRO: PLAN_CATALOG.PRO.photoQuota,
  ENTERPRISE: PLAN_CATALOG.ENTERPRISE.photoQuota,
}
