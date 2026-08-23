import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BUSINESS_HOURS } from '@petshop/shared-types'
import {
  callApi,
  closeHarness,
  givenClerkUser,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
} from './harness.js'

/** MOD-IDENT-02 — Onboarding Wizard. */

const ADMIN_PERMISSIONS = ['tenant:read', 'tenant:configure', 'tenant:read_settings'] as const
/** A recepção lê as configurações, mas não as altera. */
const RECEPTIONIST_PERMISSIONS = ['tenant:read', 'tenant:read_settings'] as const

interface Session {
  clerkUserId: string
  tenantId: string
  userId: string
}

async function givenTenant(slug: string): Promise<Session> {
  const clerkUserId = givenClerkUser(`${slug}@petshop.test`)
  const created = await callApi({
    method: 'POST',
    url: '/v1/tenants',
    clerkUserId,
    payload: { name: 'Petshop do João', slug, plan: 'STARTER', timezone: 'America/Sao_Paulo' },
  })
  const tenantId = created.json().id
  const membership = await ownerPrisma.membership.findFirstOrThrow({ where: { tenantId } })
  return { clerkUserId, tenantId, userId: membership.userId }
}

function asAdmin(session: Session) {
  return {
    clerkUserId: session.clerkUserId,
    userId: session.userId,
    tenantId: session.tenantId,
    role: 'TENANT_ADMIN' as const,
    permissions: [...ADMIN_PERMISSIONS],
  }
}

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
})

afterAll(closeHarness)

describe('AC-01 — happy path das 4 etapas', () => {
  it('avança etapa a etapa e conclui o wizard', async () => {
    const session = await givenTenant('wizard')
    const admin = asAdmin(session)

    const step1 = await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 1, data: { name: 'Petshop do João Ltda', legalName: 'João Pet ME' } },
    })
    expect(step1.statusCode).toBe(200)
    expect(step1.json().onboardingStep).toBe(2)
    expect(step1.json().name).toBe('Petshop do João Ltda')

    const step2 = await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 2, data: { plan: 'PRO' } },
    })
    expect(step2.json().onboardingStep).toBe(3)
    expect(step2.json().plan).toBe('PRO')

    const step3 = await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: {
        step: 3,
        data: {
          timezone: 'America/Sao_Paulo',
          businessHours: DEFAULT_BUSINESS_HOURS,
          cancellationWindowHours: 48,
          minBookingNoticeHours: 4,
        },
      },
    })
    expect(step3.json().onboardingStep).toBe(4)

    const settings = await ownerPrisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: session.tenantId },
    })
    expect(settings.cancellationWindowHours).toBe(48)
    expect(settings.minBookingNoticeHours).toBe(4)

    const step4 = await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 4, data: { branding: { primaryColor: '#0F766E' } } },
    })
    expect(step4.statusCode).toBe(200)
    expect(step4.json().onboardingCompletedAt).toBeTruthy()

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: session.tenantId } })
    expect(tenant.onboardingCompletedAt).toBeTruthy()
    expect(tenant.onboardingStepsSkipped).toEqual([])

    const branding = (
      await ownerPrisma.tenantSettings.findUniqueOrThrow({ where: { tenantId: session.tenantId } })
    ).branding as { primaryColor: string }
    expect(branding.primaryColor).toBe('#0F766E')

    const actions = (
      await ownerPrisma.auditLog.findMany({ where: { tenantId: session.tenantId } })
    ).map((log) => log.action)
    expect(actions).toContain('tenant.onboarding_completed')
  })
})

describe('AC-02 — validação de horário', () => {
  it('recusa fechamento anterior à abertura com 422 e a mensagem do PRD', async () => {
    const session = await givenTenant('horario')

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: {
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
      },
    })

    expect(response.statusCode).toBe(422)
    const problem = response.json()
    expect(problem.code).toBe('ERR_IDENT_002')
    expect(problem.detail).toBe('Horário de fechamento deve ser posterior ao de abertura')
    expect(problem.errors[0].field).toContain('monday')

    // A etapa não avançou.
    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: session.tenantId } })
    expect(tenant.onboardingStep).toBe(1)
  })

  it('recusa janela de cancelamento fora do intervalo permitido', async () => {
    const session = await givenTenant('janela')
    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      payload: { cancellationWindowHours: 200 },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_IDENT_002')
  })
})

describe('AC-03 — abandono e retomada', () => {
  it('preserva os dados e devolve a etapa em que o admin parou', async () => {
    const session = await givenTenant('abandono')
    const admin = asAdmin(session)

    await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 1, data: { name: 'Petshop Retomado', legalName: 'Retomado ME' } },
    })

    // Três dias depois, novo login: o estado veio do banco, não da sessão.
    const state = await callApi({ ...admin, method: 'GET', url: '/v1/tenants/me/onboarding' })
    expect(state.json()).toMatchObject({ onboardingStep: 2, onboardingCompletedAt: null })

    const tenant = await callApi({ ...admin, method: 'GET', url: '/v1/tenants/me' })
    expect(tenant.json().name).toBe('Petshop Retomado')
    expect(tenant.json().legalName).toBe('Retomado ME')
  })

  it('permite reenviar uma etapa anterior sem regredir o progresso', async () => {
    const session = await givenTenant('reenvio')
    const admin = asAdmin(session)

    await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 1, data: { name: 'Primeiro nome' } },
    })
    await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 2, data: { plan: 'PRO' } },
    })

    const corrected = await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 1, data: { name: 'Nome corrigido' } },
    })

    expect(corrected.json().name).toBe('Nome corrigido')
    // Corrigir a etapa 1 não devolve o usuário para o começo do wizard.
    expect(corrected.json().onboardingStep).toBe(3)
  })

  it('deixa pular a identidade visual sem bloquear o uso do sistema', async () => {
    const session = await givenTenant('pular')

    const done = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 4, skipped: true },
    })

    expect(done.json().onboardingCompletedAt).toBeTruthy()
    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: session.tenantId } })
    expect(tenant.onboardingStepsSkipped).toEqual([4])
  })

  it('recusa a etapa 5, que saiu junto com o convite de equipe', async () => {
    const session = await givenTenant('etapa5')
    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: '/v1/tenants/me/onboarding',
      payload: { step: 5, skipped: true },
    })
    expect(response.statusCode).toBe(422)
  })

  /**
   * Tenant provisionado antes de a etapa de equipe sair carrega `onboarding_step = 5`,
   * que o contrato não admite mais. O clamp na leitura é o que evita uma migration.
   */
  it('prende a etapa herdada de cinco passos ao último passo vigente', async () => {
    const session = await givenTenant('legado')
    await ownerPrisma.tenant.update({
      where: { id: session.tenantId },
      data: { onboardingStep: 5 },
    })

    const state = await callApi({
      ...asAdmin(session),
      method: 'GET',
      url: '/v1/tenants/me/onboarding',
    })
    expect(state.statusCode).toBe(200)
    expect(state.json().onboardingStep).toBe(4)

    const tenant = await callApi({ ...asAdmin(session), method: 'GET', url: '/v1/tenants/me' })
    expect(tenant.json().onboardingStep).toBe(4)
  })
})

describe('configurações do tenant', () => {
  it('lê e atualiza, mantendo a janela de 24h como padrão', async () => {
    const session = await givenTenant('config')
    const admin = asAdmin(session)

    const read = await callApi({ ...admin, method: 'GET', url: '/v1/tenants/me/settings' })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({
      cancellationWindowHours: 24,
      minBookingNoticeHours: 2,
      whatsappProvisioning: 'OWN_NUMBER',
      onlineBookingEnabled: true,
    })

    const updated = await callApi({
      ...admin,
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      payload: { cancellationWindowHours: 48, noShowFeePercent: 50, branding: { primaryColor: '#0F766E' } },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().cancellationWindowHours).toBe(48)
    expect(updated.json().noShowFeePercent).toBe(50)

    const actions = (
      await ownerPrisma.auditLog.findMany({ where: { tenantId: session.tenantId } })
    ).map((log) => log.action)
    expect(actions).toContain('tenant.settings_updated')
  })

  /**
   * A tela de configurações abre em modo leitura para a recepção. A distinção precisa
   * valer no servidor: esconder o botão de salvar é conveniência, não controle.
   */
  it('deixa a recepção ler as configurações, mas não alterá-las', async () => {
    const session = await givenTenant('recepcao')
    const receptionist = {
      clerkUserId: session.clerkUserId,
      userId: session.userId,
      tenantId: session.tenantId,
      role: 'RECEPTIONIST' as const,
      permissions: [...RECEPTIONIST_PERMISSIONS],
    }

    const read = await callApi({ ...receptionist, method: 'GET', url: '/v1/tenants/me/settings' })
    expect(read.statusCode).toBe(200)

    const blocked = await callApi({
      ...receptionist,
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      payload: { cancellationWindowHours: 1 },
    })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().detail).toBe('Seu perfil não permite alterar as configurações')

    const settings = await ownerPrisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: session.tenantId },
    })
    expect(settings.cancellationWindowHours).toBe(24)
  })

  /** Aba "Dados" da tela de configurações: nome e razão social fora do wizard. */
  it('atualiza nome e razão social do estabelecimento depois do onboarding', async () => {
    const session = await givenTenant('dados')

    const updated = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: '/v1/tenants/me',
      payload: { name: 'Petshop Amarillys', legalName: 'Amarillys Pet ME' },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json().name).toBe('Petshop Amarillys')
    expect(updated.json().legalName).toBe('Amarillys Pet ME')
    // O endereço do portal é permanente: o PATCH não o toca.
    expect(updated.json().slug).toBe('dados')
  })
})
