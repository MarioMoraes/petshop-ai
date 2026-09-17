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
 * O que um plano libera além do anterior. A operação (agenda, tutores, pets, prontuário,
 * financeiro, PDFs, e-mail) não tem chave: está em todos os planos e não se bloqueia.
 */
export const PLAN_FEATURES = [
  'WHATSAPP',
  'CAMPAIGNS',
  'PORTAL',
  'SITE',
  'TAXI',
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
  PORTAL: 'Portal do Tutor e agendamento online',
  SITE: 'Site do estabelecimento com domínio próprio',
  TAXI: 'Taxi Dog',
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
    ],
  },
  PRO: {
    key: 'PRO',
    name: 'Pro',
    pitch: 'Para equipes que querem o cliente perto: WhatsApp com IA, portal e site.',
    priceCents: 29_900,
    seats: 15,
    photoQuota: 5_000,
    adds: ['WHATSAPP', 'CAMPAIGNS', 'PORTAL', 'SITE', 'TAXI', 'AI_AGENT'],
    includesLead: 'Tudo do Starter, mais',
    includes: [
      'WhatsApp com mensagens automáticas',
      'Campanhas, aniversário e cobrança',
      'Portal do Tutor com agendamento online',
      'Site do estabelecimento',
      'Taxi Dog',
      'Agente de IA no WhatsApp',
      'Suporte por WhatsApp',
    ],
  },
  ENTERPRISE: {
    key: 'ENTERPRISE',
    name: 'Enterprise',
    pitch: 'Para redes e operações grandes, com o agente de IA sob medida.',
    priceCents: null,
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
