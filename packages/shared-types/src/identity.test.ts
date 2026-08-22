import { describe, expect, it } from 'vitest'
import {
  BusinessHoursSchema,
  CreateTenantSchema,
  DEFAULT_BUSINESS_HOURS,
  OnboardingStepSchema,
  TenantSettingsSchema,
  isReservedSlug,
} from './identity.js'
import { slugSuggestions, slugify } from './slug.js'
import { ROLE_PERMISSIONS, isAssignableRole, roleHasPermission } from './permissions.js'

describe('slug (MOD-IDENT-01)', () => {
  it('aceita slug válido e rejeita os fora do padrão', () => {
    expect(CreateTenantSchema.safeParse({ name: 'Petshop do João', slug: 'petshopdojoao' }).success).toBe(true)
    expect(CreateTenantSchema.safeParse({ name: 'Petshop', slug: 'ab' }).success).toBe(false)
    expect(CreateTenantSchema.safeParse({ name: 'Petshop', slug: 'Petshop' }).success).toBe(false)
    expect(CreateTenantSchema.safeParse({ name: 'Petshop', slug: '-petshop' }).success).toBe(false)
  })

  it('aplica os defaults de plano e fuso', () => {
    const parsed = CreateTenantSchema.parse({ name: 'Petshop do João', slug: 'petshopdojoao' })
    expect(parsed.plan).toBe('STARTER')
    expect(parsed.timezone).toBe('America/Sao_Paulo')
  })

  // AC-04: slugs reservados pela plataforma.
  it('reconhece slugs reservados', () => {
    for (const reserved of ['admin', 'api', 'www', 'app', 'portal']) {
      expect(isReservedSlug(reserved)).toBe(true)
    }
    expect(isReservedSlug('petshopdojoao')).toBe(false)
  })

  it('normaliza nome em slug removendo acentos e espaços', () => {
    expect(slugify('Petshop do João')).toBe('petshopdojoao')
    expect(slugify('Cão & Cia — Ração')).toBe('caociaracao')
  })

  // AC-02: o 409 devolve sugestões como "petshopdojoao-sp" e "petshopdojoao2".
  it('gera sugestões a partir do slug em conflito', () => {
    const suggestions = slugSuggestions('petshopdojoao', 3)
    expect(suggestions).toContain('petshopdojoao-sp')
    expect(suggestions.length).toBe(3)
    expect(suggestions.every((s) => !isReservedSlug(s))).toBe(true)
  })
})

describe('horário de funcionamento (MOD-IDENT-02 AC-02)', () => {
  it('rejeita fechamento anterior à abertura no mesmo dia', () => {
    const result = BusinessHoursSchema.safeParse({
      ...DEFAULT_BUSINESS_HOURS,
      monday: { closed: false, opensAt: '18:00', closesAt: '09:00' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'Horário de fechamento deve ser posterior ao de abertura',
      )
    }
  })

  it('aceita dia fechado sem validar o intervalo', () => {
    const result = BusinessHoursSchema.safeParse({
      ...DEFAULT_BUSINESS_HOURS,
      sunday: { closed: true, opensAt: '18:00', closesAt: '09:00' },
    })
    expect(result.success).toBe(true)
  })

  it('aceita a grade padrão', () => {
    expect(BusinessHoursSchema.safeParse(DEFAULT_BUSINESS_HOURS).success).toBe(true)
  })
})

describe('configurações do tenant (MOD-IDENT-08 AC-02)', () => {
  it('rejeita janela de cancelamento acima de 72 horas', () => {
    const result = TenantSettingsSchema.partial().safeParse({ cancellationWindowHours: 200 })
    expect(result.success).toBe(false)
  })

  it('usa 24 horas como janela padrão de cancelamento', () => {
    const parsed = TenantSettingsSchema.parse({
      branding: { primaryColor: '#0F766E' },
      businessHours: DEFAULT_BUSINESS_HOURS,
    })
    expect(parsed.cancellationWindowHours).toBe(24)
    expect(parsed.minBookingNoticeHours).toBe(2)
    expect(parsed.whatsappProvisioning).toBe('OWN_NUMBER')
  })
})

describe('etapas do onboarding (MOD-IDENT-02)', () => {
  it('valida o payload de cada etapa pelo discriminante', () => {
    expect(OnboardingStepSchema.safeParse({ step: 2, data: { plan: 'PRO' } }).success).toBe(true)
    expect(OnboardingStepSchema.safeParse({ step: 2, data: { plan: 'GOLD' } }).success).toBe(false)
  })

  it('aceita a etapa 4 apenas como pulada nesta fase', () => {
    expect(OnboardingStepSchema.safeParse({ step: 4, skipped: true }).success).toBe(true)
    expect(OnboardingStepSchema.safeParse({ step: 4, skipped: false }).success).toBe(false)
  })

  it('rejeita horário inválido dentro da etapa 3', () => {
    const result = OnboardingStepSchema.safeParse({
      step: 3,
      data: {
        timezone: 'America/Sao_Paulo',
        businessHours: {
          ...DEFAULT_BUSINESS_HOURS,
          monday: { closed: false, opensAt: '18:00', closesAt: '09:00' },
        },
        cancellationWindowHours: 24,
        minBookingNoticeHours: 2,
      },
    })
    expect(result.success).toBe(false)
  })
})

describe('matriz de permissões (MOD-IDENT-04)', () => {
  // AC-01 e AC-02: a recepção lê tutores mas não os exclui.
  it('dá tutor:read à recepção e nega tutor:delete', () => {
    expect(roleHasPermission('RECEPTIONIST', 'tutor:read')).toBe(true)
    expect(roleHasPermission('RECEPTIONIST', 'tutor:delete')).toBe(false)
  })

  it('reserva a exclusão de tutores a admin e super admin', () => {
    expect(roleHasPermission('TENANT_ADMIN', 'tutor:delete')).toBe(true)
    expect(roleHasPermission('SUPER_ADMIN', 'tutor:delete')).toBe(true)
    for (const role of ['GROOMER', 'BATHER', 'VET', 'DRIVER', 'TUTOR'] as const) {
      expect(roleHasPermission(role, 'tutor:delete')).toBe(false)
    }
  })

  it('limita profissionais de banho e tosa a alertas e observações do prontuário', () => {
    for (const role of ['GROOMER', 'BATHER'] as const) {
      expect(roleHasPermission(role, 'record:read_alerts')).toBe(true)
      expect(roleHasPermission(role, 'record:read')).toBe(false)
      expect(roleHasPermission(role, 'record:write_notes')).toBe(true)
      expect(roleHasPermission(role, 'record:write')).toBe(false)
    }
  })

  it('dá ao motorista apenas a visão parcial das corridas atribuídas', () => {
    expect(roleHasPermission('DRIVER', 'tutor:read_assigned')).toBe(true)
    expect(roleHasPermission('DRIVER', 'tutor:read')).toBe(false)
    expect(roleHasPermission('DRIVER', 'taxi:operate')).toBe(true)
  })

  it('restringe estorno financeiro a admin', () => {
    expect(roleHasPermission('RECEPTIONIST', 'finance:create')).toBe(true)
    expect(roleHasPermission('RECEPTIONIST', 'finance:refund')).toBe(false)
    expect(roleHasPermission('TENANT_ADMIN', 'finance:refund')).toBe(true)
  })

  // RN-05: TUTOR nunca é membership de operação; SUPER_ADMIN é papel de plataforma.
  it('não permite atribuir TUTOR nem SUPER_ADMIN a um membership', () => {
    expect(isAssignableRole('TUTOR')).toBe(false)
    expect(isAssignableRole('SUPER_ADMIN')).toBe(false)
    expect(isAssignableRole('GROOMER')).toBe(true)
  })

  it('define permissões para os 8 papéis do PRD', () => {
    expect(Object.keys(ROLE_PERMISSIONS)).toHaveLength(8)
  })
})
