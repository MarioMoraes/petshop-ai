import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { SERVICE_HEADERS, verifyServiceHeaders } from '@petshop/service-auth'
import {
  closeHarness,
  getGateway,
  givenToken,
  lastEchoed,
  ownerPrisma,
  resetDatabase,
  seedMember,
  seedTenant,
} from './harness.js'

/** api-gateway — autenticação, resolução de tenant e propagação de contexto. */

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET!

beforeEach(resetDatabase)
afterAll(closeHarness)

async function call(options: {
  method?: 'GET' | 'POST' | 'PATCH'
  url: string
  token?: string
  headers?: Record<string, string>
  payload?: unknown
}) {
  const app = await getGateway()
  return app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

describe('autenticação', () => {
  it('recusa requisição sem token', async () => {
    const response = await call({ url: '/v1/me' })
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json().code).toBe('ERR_IDENT_005')
  })

  it('recusa token desconhecido', async () => {
    const response = await call({ url: '/v1/me', token: 'tok_inexistente' })
    expect(response.statusCode).toBe(401)
    expect(response.json().detail).toBe('Sessão inválida ou expirada')
  })

  it('deixa /health passar sem token', async () => {
    const response = await call({ url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json().service).toBe('api-gateway')
  })

  it('devolve 404 para rota sem serviço de destino', async () => {
    const token = givenToken({ clerkUserId: 'user_semrota' })
    const response = await call({ url: '/v1/inexistente', token })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_IDENT_001')
  })
})

describe('propagação do contexto ao serviço', () => {
  it('assina os headers com o contexto resolvido', async () => {
    const tenant = await seedTenant('propaga')
    const member = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const token = givenToken({
      clerkUserId: member.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
      permVersion: 1,
    })

    const response = await call({ url: '/v1/memberships', token })
    expect(response.statusCode).toBe(200)

    const forwarded = lastEchoed()
    const verified = verifyServiceHeaders(forwarded.headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return

    expect(verified.context.clerkUserId).toBe(member.clerkUserId)
    expect(verified.context.userId).toBe(member.userId)
    expect(verified.context.tenantId).toBe(tenant.tenantId)
    expect(verified.context.role).toBe('RECEPTIONIST')
    expect(verified.context.permissions).toContain('tutor:read')
    expect(verified.context.permissions).not.toContain('tutor:delete')
  })

  it('não repassa o Authorization do cliente adiante', async () => {
    const tenant = await seedTenant('semauth')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    await call({ url: '/v1/roles', token })

    // O serviço de destino nunca vê o token do usuário.
    expect(lastEchoed().headers.authorization).toBeUndefined()
  })

  it('descarta headers internos forjados pelo cliente', async () => {
    const tenant = await seedTenant('forjado')
    const outro = await seedTenant('vitima')
    const member = await seedMember(tenant.tenantId, 'BATHER')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    // O cliente tenta se declarar admin de outro tenant.
    await call({
      url: '/v1/roles',
      token,
      headers: {
        [SERVICE_HEADERS.tenantId]: outro.tenantId,
        [SERVICE_HEADERS.role]: 'TENANT_ADMIN',
        [SERVICE_HEADERS.permissions]: 'tutor:delete,finance:refund',
      },
    })

    const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return

    // Prevalece o que o gateway resolveu, não o que o cliente afirmou.
    expect(verified.context.tenantId).toBe(tenant.tenantId)
    expect(verified.context.role).toBe('BATHER')
    expect(verified.context.permissions).not.toContain('tutor:delete')
  })

  it('encaminha sem tenant quando o usuário ainda não tem Organization', async () => {
    const token = givenToken({ clerkUserId: 'user_novo', clerkOrgId: null })

    const response = await call({
      method: 'POST',
      url: '/v1/tenants',
      token,
      payload: { name: 'Petshop Novo', slug: 'petshopnovo' },
    })
    expect(response.statusCode).toBe(200)

    const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.context.tenantId).toBeUndefined()
    expect(verified.context.clerkUserId).toBe('user_novo')
  })

  it('repassa o corpo e o request id', async () => {
    const tenant = await seedTenant('corpo')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    await call({
      method: 'PATCH',
      url: '/v1/tenants/me',
      token,
      payload: { name: 'Novo Nome' },
    })

    const forwarded = lastEchoed()
    expect(forwarded.body).toEqual({ name: 'Novo Nome' })
    expect(forwarded.headers['x-request-id']).toBeTruthy()
  })
})

describe('AC-03 de MOD-IDENT-04 — papel alterado com sessão ativa', () => {
  it('aplica o papel novo mesmo com token trazendo permVersion antigo', async () => {
    const tenant = await seedTenant('rebaixa')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')

    // Token emitido quando o usuário ainda era admin.
    const token = givenToken({
      clerkUserId: member.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
      permVersion: 1,
    })

    const before = await call({ url: '/v1/roles', token })
    expect(before.statusCode).toBe(200)
    const permissionsBefore = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(permissionsBefore.ok && permissionsBefore.context.permissions).toContain('tutor:delete')

    // O admin rebaixa o usuário; permVersion vai para 2.
    await ownerPrisma.membership.update({
      where: { id: member.membershipId },
      data: { roleKey: 'RECEPTIONIST', permVersion: 2 },
    })

    // Mesmo token de antes: o gateway detecta e aplica o papel novo.
    const after = await call({ url: '/v1/roles', token })
    expect(after.statusCode).toBe(200)
    const permissionsAfter = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(permissionsAfter.ok).toBe(true)
    if (!permissionsAfter.ok) return
    expect(permissionsAfter.context.role).toBe('RECEPTIONIST')
    expect(permissionsAfter.context.permissions).not.toContain('tutor:delete')
    expect(permissionsAfter.context.permVersion).toBe(2)
  })

  it('não envia permissão nenhuma quando o membership foi removido', async () => {
    const tenant = await seedTenant('removido')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    await ownerPrisma.membership.update({
      where: { id: member.membershipId },
      data: { status: 'REMOVED' },
    })

    await call({ url: '/v1/roles', token })
    const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.context.permissions).toEqual([])
    expect(verified.context.role).toBeUndefined()
  })
})

describe('RN-04 — tenant suspenso', () => {
  it('bloqueia escrita com 423 ERR_IDENT_008', async () => {
    const tenant = await seedTenant('suspenso', 'SUSPENDED')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      method: 'PATCH',
      url: '/v1/tenants/me',
      token,
      payload: { name: 'Tentativa' },
    })

    expect(response.statusCode).toBe(423)
    expect(response.json().code).toBe('ERR_IDENT_008')
    expect(response.json().detail).toContain('Regularize a assinatura')
  })

  it('mantém a leitura liberada, para consulta e exportação LGPD', async () => {
    const tenant = await seedTenant('suspensoleitura', 'SUSPENDED')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({ url: '/v1/tenants/me', token })
    expect(response.statusCode).toBe(200)
  })

  it('não bloqueia tenant ativo', async () => {
    const tenant = await seedTenant('ativo', 'ACTIVE')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      method: 'PATCH',
      url: '/v1/tenants/me',
      token,
      payload: { name: 'Permitido' },
    })
    expect(response.statusCode).toBe(200)
  })
})
