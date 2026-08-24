import { z } from 'zod'
import { ROLE_KEYS } from './permissions.js'

/** PRD identidade_tenancy_01 §5 — contratos de entrada e saída do identity-service. */

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{2,49}$/

/**
 * AC-04 de MOD-IDENT-01: slugs reservados pela plataforma. Inclui os subdomínios
 * operacionais e os nomes que colidiriam com rotas do produto.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'www',
  'app',
  'portal',
  'auth',
  'login',
  'signup',
  'billing',
  'blog',
  'cdn',
  'dashboard',
  'docs',
  'help',
  'mail',
  'petshopai',
  'static',
  'status',
  'support',
  'suporte',
  'webhooks',
])

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase())
}

export const TenantStatusSchema = z.enum([
  'PROVISIONING',
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'TERMINATED',
  'PROVISIONING_FAILED',
])
export type TenantStatus = z.infer<typeof TenantStatusSchema>

export const PlanSchema = z.enum(['STARTER', 'PRO', 'ENTERPRISE'])
export type Plan = z.infer<typeof PlanSchema>

/** RN-11 — limite de usuários por plano, verificado no convite e no aceite. */
export const PLAN_SEAT_LIMITS: Record<Plan, number | null> = {
  STARTER: 5,
  PRO: 15,
  ENTERPRISE: null,
}

export const RoleKeySchema = z.enum(ROLE_KEYS)

// As etapas do wizard (MOD-IDENT-02) moram aqui, e não na seção de onboarding mais
// abaixo, porque `TenantResponseSchema` limita `onboardingStep` por elas — uma const
// declarada depois estouraria na avaliação do módulo.
export const ONBOARDING_STEPS = [1, 2, 3, 4] as const
export const ONBOARDING_LAST_STEP = 4

// ─── Provisionamento (MOD-IDENT-01) ──────────────────────────────────────────

export const CreateTenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().regex(SLUG_REGEX, 'Use apenas letras minúsculas, números e hífen'),
  legalName: z.string().max(160).optional(),
  cnpj: z
    .string()
    .regex(/^\d{14}$/, 'O CNPJ deve ter 14 dígitos, sem pontuação')
    .optional(),
  plan: PlanSchema.default('STARTER'),
  timezone: z.string().default('America/Sao_Paulo'),
})
export type CreateTenantInput = z.output<typeof CreateTenantSchema>

export const UpdateTenantSchema = z
  .object({
    name: z.string().min(2).max(120),
    legalName: z.string().max(160).nullable(),
    cnpj: z.string().regex(/^\d{14}$/).nullable(),
  })
  .partial()
export type UpdateTenantInput = z.output<typeof UpdateTenantSchema>

export const TenantResponseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  legalName: z.string().nullable(),
  cnpj: z.string().nullable(),
  status: TenantStatusSchema,
  plan: PlanSchema,
  trialEndsAt: z.iso.datetime().nullable(),
  onboardingStep: z.number().int().min(1).max(ONBOARDING_LAST_STEP),
  onboardingCompletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type TenantResponse = z.infer<typeof TenantResponseSchema>

export const SlugAvailabilitySchema = z.object({
  slug: z.string(),
  available: z.boolean(),
  reason: z.enum(['AVAILABLE', 'TAKEN', 'RESERVED', 'INVALID']),
  suggestions: z.array(z.string()),
})
export type SlugAvailability = z.infer<typeof SlugAvailabilitySchema>

// ─── Configurações do tenant (MOD-IDENT-08, parcial) ─────────────────────────

export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  monday: 'Segunda',
  tuesday: 'Terça',
  wednesday: 'Quarta',
  thursday: 'Quinta',
  friday: 'Sexta',
  saturday: 'Sábado',
  sunday: 'Domingo',
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * AC-02 de MOD-IDENT-02: `opensAt = 18:00` com `closesAt = 09:00` no mesmo dia é
 * inválido — o fechamento tem de ser posterior à abertura.
 */
export const DayHoursSchema = z
  .object({
    closed: z.boolean().default(false),
    opensAt: z.string().regex(TIME_REGEX, 'Use o formato HH:MM'),
    closesAt: z.string().regex(TIME_REGEX, 'Use o formato HH:MM'),
  })
  .refine((day) => day.closed || toMinutes(day.closesAt) > toMinutes(day.opensAt), {
    message: 'Horário de fechamento deve ser posterior ao de abertura',
    path: ['closesAt'],
  })
export type DayHours = z.output<typeof DayHoursSchema>

export const BusinessHoursSchema = z.object({
  monday: DayHoursSchema,
  tuesday: DayHoursSchema,
  wednesday: DayHoursSchema,
  thursday: DayHoursSchema,
  friday: DayHoursSchema,
  saturday: DayHoursSchema,
  sunday: DayHoursSchema,
})
export type BusinessHours = z.output<typeof BusinessHoursSchema>

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  monday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
  tuesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
  wednesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
  thursday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
  friday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
  saturday: { closed: false, opensAt: '08:00', closesAt: '13:00' },
  sunday: { closed: true, opensAt: '08:00', closesAt: '13:00' },
}

export const BrandingSchema = z.object({
  logoUrl: z.url().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB'),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB')
    .optional(),
})
export type Branding = z.output<typeof BrandingSchema>

export const DEFAULT_BRANDING: Branding = { primaryColor: '#E34A32' }

export const WhatsappProvisioningSchema = z.enum(['OWN_NUMBER'])

export const TenantSettingsSchema = z.object({
  timezone: z.string().default('America/Sao_Paulo'),
  // Decisão de negócio: janela padrão de cancelamento é de 24 horas.
  cancellationWindowHours: z.number().int().min(0).max(72).default(24),
  noShowFeePercent: z.number().int().min(0).max(100).default(0),
  minBookingNoticeHours: z.number().int().min(0).max(168).default(2),
  allowOverbooking: z.boolean().default(false),
  onlineBookingEnabled: z.boolean().default(true),
  branding: BrandingSchema,
  businessHours: BusinessHoursSchema,
  whatsappProvisioning: WhatsappProvisioningSchema.default('OWN_NUMBER'),
})
export type TenantSettings = z.output<typeof TenantSettingsSchema>

export const UpdateTenantSettingsSchema = TenantSettingsSchema.partial()
export type UpdateTenantSettingsInput = z.output<typeof UpdateTenantSettingsSchema>

// ─── Onboarding Wizard (MOD-IDENT-02) ────────────────────────────────────────

export const ONBOARDING_STEP_TITLES: Record<number, string> = {
  1: 'Dados do petshop',
  2: 'Escolha do plano',
  3: 'Configuração operacional',
  4: 'Primeiro acesso',
}

/**
 * Etapas que o admin pode pular sem bloquear o uso do sistema (AC-03).
 *
 * O AC-01 descreve cinco etapas, com "convite de equipe" na quarta. Ela saiu: o
 * envio de convites é MOD-IDENT-06 e não existe, então a etapa era uma tela de
 * "Continuar" que não coletava nada — atravessar o onboarding para chegar a ela e
 * clicar em um botão é custo sem contrapartida. O convite volta pelo menu Equipe
 * quando `POST /v1/invitations` existir, e o onboarding continua sendo só a
 * configuração do estabelecimento.
 */
export const SKIPPABLE_ONBOARDING_STEPS = [4] as const

const Step1Schema = z.object({
  step: z.literal(1),
  data: z.object({
    name: z.string().min(2).max(120),
    legalName: z.string().max(160).nullish(),
    cnpj: z.string().regex(/^\d{14}$/).nullish(),
  }),
})

const Step2Schema = z.object({
  step: z.literal(2),
  data: z.object({ plan: PlanSchema }),
})

/**
 * Quem atende, coletado na etapa 3.
 *
 * É o único dado da agenda que o provisionamento **não** consegue semear: serviço e
 * preço têm padrão de mercado, nome de gente não tem. Sem pelo menos um profissional
 * a agenda não existe, por mais completo que o catálogo esteja.
 *
 * A jornada não é perguntada aqui de propósito: ela nasce igual ao horário de
 * funcionamento que o próprio passo acabou de definir, e quem trabalha em horário
 * diferente ajusta na tela de profissionais. Perguntar a semana de cada pessoa
 * dentro de um wizard transformaria a etapa em formulário de RH.
 */
const OnboardingProfessionalSchema = z.object({
  displayName: z.string().trim().min(2).max(60),
  roleKey: z.enum(['GROOMER', 'BATHER', 'VET', 'DRIVER']),
  maxConcurrentPets: z.number().int().min(1).max(20).default(1),
})
export type OnboardingProfessionalInput = z.output<typeof OnboardingProfessionalSchema>

const Step3Schema = z.object({
  step: z.literal(3),
  data: z.object({
    timezone: z.string(),
    businessHours: BusinessHoursSchema,
    cancellationWindowHours: z.number().int().min(0).max(72),
    minBookingNoticeHours: z.number().int().min(0).max(168),
    noShowFeePercent: z.number().int().min(0).max(100).optional(),
    /** Vazio é permitido: o admin pode cadastrar a equipe depois, em `/profissionais`. */
    professionals: z.array(OnboardingProfessionalSchema).max(30).default([]),
  }),
})

const Step4Schema = z.object({
  step: z.literal(4),
  skipped: z.boolean().optional(),
  data: z.object({ branding: BrandingSchema }).optional(),
})

export const OnboardingStepSchema = z.discriminatedUnion('step', [
  Step1Schema,
  Step2Schema,
  Step3Schema,
  Step4Schema,
])
export type OnboardingStepInput = z.output<typeof OnboardingStepSchema>

export const OnboardingStateSchema = z.object({
  onboardingStep: z.number().int().min(1).max(ONBOARDING_LAST_STEP),
  onboardingCompletedAt: z.iso.datetime().nullable(),
  stepsSkipped: z.array(z.number().int()),
})
export type OnboardingState = z.infer<typeof OnboardingStateSchema>

// ─── Identidade do usuário corrente (MOD-IDENT-04) ───────────────────────────

export const MembershipSummarySchema = z.object({
  tenantId: z.uuid(),
  tenantName: z.string(),
  tenantSlug: z.string(),
  roleKey: RoleKeySchema,
  roleLabel: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']),
})

export const MeResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    clerkUserId: z.string(),
    email: z.email(),
    fullName: z.string(),
    avatarUrl: z.string().nullable(),
    mfaEnabled: z.boolean(),
  }),
  currentTenant: TenantResponseSchema.nullable(),
  /**
   * `branding.primaryColor` do tenant corrente (Configurações → Identidade visual),
   * já resolvido com o padrão do sistema quando o estabelecimento ainda não tem
   * `TenantSettings` (onboarding em andamento). `null` sem tenant corrente. É o que
   * o frontend usa para colorir o foco dos campos de formulário com a cor da marca.
   */
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB')
    .nullable(),
  memberships: z.array(MembershipSummarySchema),
  permissions: z.array(z.string()),
  permVersion: z.number().int(),
})
export type MeResponse = z.infer<typeof MeResponseSchema>

export const RoleResponseSchema = z.object({
  key: RoleKeySchema,
  label: z.string(),
  isSystem: z.boolean(),
  assignable: z.boolean(),
  permissions: z.array(z.string()),
})
export type RoleResponse = z.infer<typeof RoleResponseSchema>
