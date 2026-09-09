import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callApi,
  closeHarness,
  fakeClerk,
  givenClerkUser,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
} from './fixtures.js'

/** MOD-IDENT-01 — Provisionamento de Tenant. */

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
})

afterAll(closeHarness)

const validPayload = {
  name: 'Petshop do João',
  slug: 'petshopdojoao',
  plan: 'STARTER',
  timezone: 'America/Sao_Paulo',
}

describe('AC-01 — happy path', () => {
  it('cria o tenant em TRIAL com admin, configurações e trial de 14 dias', async () => {
    const clerkUserId = givenClerkUser('joao@petshop.test')

    const response = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: validPayload,
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body).toMatchObject({
      slug: 'petshopdojoao',
      status: 'TRIAL',
      plan: 'STARTER',
      onboardingStep: 1,
    })

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: body.id } })
    expect(tenant.clerkOrgId).toBeTruthy()
    expect(tenant.provisioningKey).toBeTruthy()

    // Trial de 14 dias, com folga de um dia na comparação.
    const trialDays = (tenant.trialEndsAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(trialDays).toBeGreaterThan(13)
    expect(trialDays).toBeLessThan(15)

    // Organization criada no Clerk com o mesmo slug do tenant.
    expect(fakeClerk.organizations.get('petshopdojoao')).toBeTruthy()

    // Membership do solicitante como TENANT_ADMIN.
    const membership = await ownerPrisma.membership.findFirstOrThrow({
      where: { tenantId: tenant.id },
    })
    expect(membership.roleKey).toBe('TENANT_ADMIN')
    expect(membership.status).toBe('ACTIVE')

    // Configurações padrão, com a janela de cancelamento de 24h da decisão de negócio.
    const settings = await ownerPrisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    })
    expect(settings.cancellationWindowHours).toBe(24)
    expect(settings.minBookingNoticeHours).toBe(2)
    expect(settings.timezone).toBe('America/Sao_Paulo')

    // DEK do tenant criada — sem ela nenhum campo cifrado pode ser gravado.
    expect(await ownerPrisma.dataKey.findUnique({ where: { tenantId: tenant.id } })).toBeTruthy()

    // Trilha de auditoria da criação e da transição de status.
    const actions = (
      await ownerPrisma.auditLog.findMany({ where: { tenantId: tenant.id } })
    ).map((log) => log.action)
    expect(actions).toContain('tenant.created')
    expect(actions).toContain('tenant.status_changed')
  })

  it('cifra o CNPJ em repouso e o devolve decifrado na API', async () => {
    const clerkUserId = givenClerkUser('cnpj@petshop.test')

    const response = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: { ...validPayload, slug: 'petshopcnpj', cnpj: '12345678000199' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().cnpj).toBe('12345678000199')

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({
      where: { id: response.json().id },
    })
    expect(tenant.cnpjEncrypted).not.toContain('12345678000199')
    expect(tenant.cnpjEncrypted?.startsWith('v1:')).toBe(true)
  })
})

describe('AC-02 — slug duplicado', () => {
  it('devolve 409 ERR_IDENT_004 com sugestões e não cria nada no Clerk', async () => {
    const first = givenClerkUser('primeiro@petshop.test')
    await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId: first,
      clerkOrgId: null,
      payload: validPayload,
    })

    const callsBefore = fakeClerk.createOrganizationCalls
    const second = givenClerkUser('segundo@petshop.test')
    const response = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId: second,
      clerkOrgId: null,
      payload: validPayload,
    })

    expect(response.statusCode).toBe(409)
    expect(response.headers['content-type']).toContain('application/problem+json')

    const problem = response.json()
    expect(problem.code).toBe('ERR_IDENT_004')
    expect(problem.detail).toContain('Este endereço já está em uso')
    expect(problem.detail).toContain('petshopdojoao-sp')
    expect(problem.errors[0].field).toBe('slug')
    expect(problem.traceId).toBeTruthy()

    // O ponto do AC: a segunda tentativa não chega a tocar no Clerk.
    expect(fakeClerk.createOrganizationCalls).toBe(callsBefore)
    expect(await ownerPrisma.tenant.count()).toBe(1)
  })
})

describe('AC-03 — falha parcial no provisionamento', () => {
  it('deixa o tenant em PROVISIONING quando o Clerk falha, sem perder o cadastro', async () => {
    fakeClerk.failCreateOrganization = new Error('ETIMEDOUT ao falar com o Clerk')
    const clerkUserId = givenClerkUser('timeout@petshop.test')

    const response = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: { ...validPayload, slug: 'petshoptimeout' },
    })

    // O usuário recebe a conta criada; a tela mostra "estamos finalizando sua conta"
    // em vez de erro cru.
    expect(response.statusCode).toBe(201)
    expect(response.json().status).toBe('PROVISIONING')

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({
      where: { id: response.json().id },
    })
    expect(tenant.clerkOrgId).toBeNull()
    expect(tenant.provisioningAttempts).toBe(1)
    expect(tenant.provisioningLastError).toContain('ETIMEDOUT')
    // Membership e configurações sobreviveram: nada foi perdido.
    expect(await ownerPrisma.membership.count({ where: { tenantId: tenant.id } })).toBe(1)
  })

  it('o job de retry retoma o provisionamento de forma idempotente', async () => {
    fakeClerk.failCreateOrganization = new Error('ETIMEDOUT ao falar com o Clerk')
    const clerkUserId = givenClerkUser('retry@petshop.test')
    const created = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: { ...validPayload, slug: 'petshopretry' },
    })
    const tenantId = created.json().id

    // O Clerk volta.
    fakeClerk.failCreateOrganization = null
    const { runProvisioningRetryOnce } = await import('../../src/modules/identity/tenants/provisioning-retry.js')
    const result = await runProvisioningRetryOnce()
    expect(result.processed).toBe(1)

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    expect(tenant.status).toBe('TRIAL')
    expect(tenant.clerkOrgId).toBeTruthy()
    expect(tenant.trialEndsAt).toBeTruthy()

    // Rodar de novo não cria uma segunda Organization nem altera o estado.
    const callsAfterFirstSuccess = fakeClerk.createOrganizationCalls
    await runProvisioningRetryOnce()
    expect(fakeClerk.createOrganizationCalls).toBe(callsAfterFirstSuccess)
    expect(await ownerPrisma.tenant.count({ where: { status: 'TRIAL' } })).toBe(1)
  })

  it('reencontra a Organization já criada em vez de criar uma segunda', async () => {
    // Cenário do timeout que na verdade tinha dado certo: a Organization existe no
    // Clerk, mas a resposta se perdeu.
    const clerkUserId = givenClerkUser('orfa@petshop.test')
    fakeClerk.organizations.set('petshoporfa', {
      id: 'org_preexistente',
      slug: 'petshoporfa',
      name: 'Petshop do João',
    })

    const response = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: { ...validPayload, slug: 'petshoporfa' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().status).toBe('TRIAL')
    expect(fakeClerk.createOrganizationCalls).toBe(0)

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({
      where: { id: response.json().id },
    })
    expect(tenant.clerkOrgId).toBe('org_preexistente')
  })

  it('vai para PROVISIONING_FAILED depois de 5 tentativas', async () => {
    fakeClerk.failCreateOrganization = new Error('ETIMEDOUT ao falar com o Clerk')
    const clerkUserId = givenClerkUser('falha@petshop.test')
    const created = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: { ...validPayload, slug: 'petshopfalha' },
    })
    const tenantId = created.json().id

    const { runProvisioningRetryOnce } = await import('../../src/modules/identity/tenants/provisioning-retry.js')
    // A criação já contou a 1ª tentativa; faltam 4 para esgotar.
    for (let attempt = 0; attempt < 4; attempt++) {
      await runProvisioningRetryOnce()
    }

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    expect(tenant.provisioningAttempts).toBe(5)
    expect(tenant.status).toBe('PROVISIONING_FAILED')

    // Esgotado, sai da fila do retry.
    expect((await runProvisioningRetryOnce()).processed).toBe(0)
  })
})

describe('AC-04 — slug reservado', () => {
  it.each(['admin', 'api', 'www', 'app', 'portal'])(
    'recusa o slug reservado "%s" com 422 ERR_IDENT_002',
    async (slug) => {
      const clerkUserId = givenClerkUser(`${slug}@petshop.test`)
      const response = await callApi({
        method: 'POST',
        url: '/v1/tenants',
        clerkUserId,
        clerkOrgId: null,
        payload: { ...validPayload, slug },
      })

      expect(response.statusCode).toBe(422)
      const problem = response.json()
      expect(problem.code).toBe('ERR_IDENT_002')
      expect(problem.detail).toBe('Este endereço é reservado pela plataforma')
      expect(await ownerPrisma.tenant.count()).toBe(0)
      expect(fakeClerk.createOrganizationCalls).toBe(0)
    },
  )

  it('recusa slug fora do padrão antes de tocar o banco', async () => {
    const clerkUserId = givenClerkUser('invalido@petshop.test')
    const response = await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: { ...validPayload, slug: 'Petshop Com Espaço' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_IDENT_002')
    expect(response.json().errors[0].field).toBe('slug')
  })
})

describe('disponibilidade de slug (etapa 1 do wizard)', () => {
  it('classifica slug livre, ocupado, reservado e inválido', async () => {
    const clerkUserId = givenClerkUser('slug@petshop.test')
    await callApi({
      method: 'POST',
      url: '/v1/tenants',
      clerkUserId,
      clerkOrgId: null,
      payload: validPayload,
    })

    const check = async (slug: string) =>
      (
        await callApi({
          method: 'GET',
          url: `/v1/tenants/slug-availability?slug=${encodeURIComponent(slug)}`,
          clerkUserId,
          clerkOrgId: null,
        })
      ).json()

    expect(await check('petshoplivre')).toMatchObject({ available: true, reason: 'AVAILABLE' })
    expect(await check('petshopdojoao')).toMatchObject({ available: false, reason: 'TAKEN' })
    expect(await check('admin')).toMatchObject({ available: false, reason: 'RESERVED' })
    expect(await check('ab')).toMatchObject({ available: false, reason: 'INVALID' })

    // Ocupado vem com alternativas que de fato estão livres.
    const taken = await check('petshopdojoao')
    expect(taken.suggestions.length).toBeGreaterThan(0)
    expect(taken.suggestions).not.toContain('petshopdojoao')
  })
})

/**
 * As duas portas do processo, vistas da rota mais exposta do módulo.
 *
 * Enquanto isto era serviço, a única credencial aceita era a assinatura HMAC do
 * gateway. Hoje a rota atende as duas: de fora chega o token do Clerk, de dentro um
 * serviço que ainda não migrou, com o contexto já assinado. O que **não** mudou é o que
 * acontece com quem não tem nenhuma das duas, e é isso que estes três casos guardam.
 */
describe('as portas de entrada', () => {
  it('recusa requisição sem token e sem assinatura', async () => {
    const { getApp } = await import('./fixtures.js')
    const app = await getApp()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      payload: validPayload,
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('ERR_IDENT_005')
  })

  /**
   * A porta de dentro continua sendo verificada, e continua sendo a mesma função.
   * `resolveInternalRequest` reconhece que **há** assinatura, falha ao conferi-la e
   * recusa — em vez de descartar os headers e ir procurar um token que não existe.
   */
  it('recusa assinatura de serviço forjada com outro segredo', async () => {
    const { signServiceHeaders } = await import('@petshop/service-auth')
    const { getApp } = await import('./fixtures.js')
    const app = await getApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: signServiceHeaders(
        { clerkUserId: 'user_forjado', permissions: [] },
        'segredo-errado',
      ),
      payload: validPayload,
    })

    expect(response.statusCode).toBe(401)
  })

  it('deixa /health passar sem credencial nenhuma', async () => {
    const { getApp } = await import('./fixtures.js')
    const app = await getApp()
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('ok')
  })
})
