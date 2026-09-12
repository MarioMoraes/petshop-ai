import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { RoleKey } from '@petshop/shared-types'
import {
  asAdmin,
  asRole,
  asStranger,
  callApi,
  closeHarness,
  givenClerkUser,
  givenTeamMember,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
} from './fixtures.js'

/**
 * MOD-IDENT-04 — RBAC, e o isolamento cross-tenant visto pela API (MOD-IDENT-07 AC-02).
 *
 * **A permissão de cada chamador sai da matriz, e não de uma lista escrita aqui.**
 * Enquanto isto era serviço, o harness assinava o contexto com as permissões que o
 * teste quisesse — o que fazia toda asserção de negação provar apenas que o guarda lê a
 * lista que recebeu. Agora a identidade entra pela porta da produção: um token, o
 * membership no banco e a matriz de papéis. Um cenário que a matriz não produz sozinha
 * se monta com `revokePermission`, que é o mecanismo real do MOD-IDENT-04.
 */

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
})

afterAll(closeHarness)

describe('AC-01 e AC-02 — permissão concedida e negada', () => {
  it('deixa a recepção listar a equipe, que está na matriz do papel', async () => {
    const session = await givenTenant('recepcao')
    const response = await callApi({
      ...(await asRole(session, 'RECEPTIONIST')),
      method: 'GET',
      url: '/v1/memberships',
    })
    expect(response.statusCode).toBe(200)
    // O administrador que criou o estabelecimento e a própria recepção.
    expect(response.json()).toHaveLength(2)
  })

  it('nega à recepção a alteração de papéis, com 403 e registro DENIED', async () => {
    const session = await givenTenant('recepcaonega')
    const member = await givenTeamMember(session, 'GROOMER', 'tosador')

    const response = await callApi({
      ...(await asRole(session, 'RECEPTIONIST')),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}`,
      payload: { role: 'VET' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const problem = response.json()
    expect(problem.code).toBe('ERR_IDENT_003')
    expect(problem.detail).toBe('Seu perfil não permite alterar papéis da equipe')

    // AC-02: a tentativa fica em audit_logs com outcome DENIED.
    const denied = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: session.tenantId, outcome: 'DENIED' },
    })
    expect(denied?.action).toBe('auth.permission_denied')
    expect(denied?.entityId).toBe('team:invite')

    // E também como evento de segurança, que alimenta a métrica de negações.
    const event = await ownerPrisma.securityEvent.findFirst({
      where: { tenantId: session.tenantId, type: 'PERMISSION_DENIED' },
    })
    expect(event?.targetId).toBe('team:invite')

    // O papel não mudou.
    const unchanged = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId },
    })
    expect(unchanged.roleKey).toBe('GROOMER')
  })

  /**
   * O banhista tem tenant, tem papel e tem permissões — só não esta. É a negação que a
   * matriz produz sozinha, e vale mais que um contexto de lista vazia: prova que
   * `team:read` de fato não está em `ROLE_PERMISSIONS.BATHER`.
   */
  it('nega quem tem papel sem `team:read` na matriz', async () => {
    const session = await givenTenant('sempermissao')
    const response = await callApi({
      ...(await asRole(session, 'BATHER')),
      method: 'GET',
      url: '/v1/memberships',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_IDENT_003')
  })

  it('exige tenant selecionado nas rotas de tenant', async () => {
    const clerkUserId = givenClerkUser('semtenant@petshop.test')
    const response = await callApi({
      ...asStranger(clerkUserId),
      method: 'GET',
      url: '/v1/tenants/me',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().detail).toBe('Selecione um estabelecimento para continuar')
  })
})

describe('AC-03 — papel alterado com sessão ativa', () => {
  it('incrementa permVersion, invalida o cache e aplica o papel novo', async () => {
    const session = await givenTenant('rebaixamento')
    const member = await givenTeamMember(session, 'TENANT_ADMIN', 'segundoadmin')

    const { getEffectivePermissions, getFreshPermissions } = await import(
      '../../src/modules/identity/rbac/service.js'
    )

    const before = await getEffectivePermissions(session.tenantId, member.userId)
    expect(before?.role).toBe('TENANT_ADMIN')
    expect(before?.permissions).toContain('tutor:delete')
    expect(before?.permVersion).toBe(1)

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}`,
      payload: { role: 'RECEPTIONIST' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ roleKey: 'RECEPTIONIST', permVersion: 2 })

    // O token do usuário rebaixado ainda carrega permVersion 1. A divergência força a
    // releitura, e é o papel novo que passa a valer.
    const fresh = await getFreshPermissions(session.tenantId, member.userId)
    expect(fresh?.permVersion).toBe(2)
    expect(fresh?.role).toBe('RECEPTIONIST')
    expect(fresh?.permissions).not.toContain('tutor:delete')

    const actions = (
      await ownerPrisma.auditLog.findMany({ where: { tenantId: session.tenantId } })
    ).map((log) => log.action)
    expect(actions).toContain('membership.role_changed')
  })

  it('republica o permVersion no metadata do membership no Clerk', async () => {
    const session = await givenTenant('permversion')
    const member = await givenTeamMember(session, 'GROOMER', 'tosadorpv')
    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: session.tenantId } })

    await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}`,
      payload: { role: 'VET' },
    })

    const { fakeClerk } = await import('./fixtures.js')
    expect(fakeClerk.permVersions.get(`${tenant.clerkOrgId}:${member.clerkUserId}`)).toBe(2)
  })

  it('marca isProfessional ao atribuir papel operacional (RN-06)', async () => {
    const session = await givenTenant('profissional')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'vira-tosador')

    await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}`,
      payload: { role: 'GROOMER' },
    })

    const updated = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId },
    })
    expect(updated.isProfessional).toBe(true)
  })
})

describe('RN-02 — o tenant precisa de ao menos um administrador', () => {
  it('recusa rebaixar o último admin com 409', async () => {
    const session = await givenTenant('ultimoadmin')

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${session.membershipId}`,
      payload: { role: 'RECEPTIONIST' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_IDENT_004')
    expect(response.json().detail).toBe('O estabelecimento precisa de ao menos um administrador')

    const unchanged = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: session.membershipId },
    })
    expect(unchanged.roleKey).toBe('TENANT_ADMIN')
  })

  it('permite rebaixar um admin quando há outro', async () => {
    const session = await givenTenant('doisadmins')
    const member = await givenTeamMember(session, 'TENANT_ADMIN', 'outroadmin')

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}`,
      payload: { role: 'RECEPTIONIST' },
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('RN-05 — papéis não atribuíveis', () => {
  it.each(['TUTOR', 'SUPER_ADMIN'])('recusa atribuir %s a um membership', async (role) => {
    const session = await givenTenant(`naoatrib${role.toLowerCase().slice(0, 5)}`)
    const member = await givenTeamMember(session, 'GROOMER', `alvo${role}`)

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}`,
      payload: { role },
    })
    expect(response.statusCode).toBe(422)
  })
})

describe('matriz de permissões exposta pela API', () => {
  it('devolve os 8 papéis com a matriz do PRD e quais são atribuíveis', async () => {
    const session = await givenTenant('matriz')
    const response = await callApi({
      ...asAdmin(session),
      method: 'GET',
      url: '/v1/roles',
    })

    expect(response.statusCode).toBe(200)
    const roles = response.json() as Array<{
      key: RoleKey
      assignable: boolean
      permissions: string[]
    }>
    expect(roles).toHaveLength(8)

    const byKey = new Map(roles.map((role) => [role.key, role]))
    expect(byKey.get('RECEPTIONIST')?.permissions).toContain('tutor:read')
    expect(byKey.get('RECEPTIONIST')?.permissions).not.toContain('tutor:delete')
    expect(byKey.get('TENANT_ADMIN')?.permissions).toContain('tutor:delete')
    expect(byKey.get('TUTOR')?.assignable).toBe(false)
    expect(byKey.get('SUPER_ADMIN')?.assignable).toBe(false)
    expect(byKey.get('GROOMER')?.assignable).toBe(true)
  })

  it('aplica override do tenant sobre a matriz padrão', async () => {
    const session = await givenTenant('override')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'recepoverride')

    // Este tenant decide que a recepção não lança no financeiro.
    await ownerPrisma.tenantRoleOverride.create({
      data: {
        tenantId: session.tenantId,
        roleKey: 'RECEPTIONIST',
        permissionKey: 'finance:create',
        granted: false,
      },
    })

    const { getFreshPermissions } = await import('../../src/modules/identity/rbac/service.js')
    const effective = await getFreshPermissions(session.tenantId, member.userId)
    expect(effective?.permissions).not.toContain('finance:create')
    expect(effective?.permissions).toContain('tutor:read')
  })
})

describe('MOD-IDENT-07 AC-02 — cross-tenant pela API', () => {
  it('devolve 404, e não 403, ao mirar recurso de outro tenant', async () => {
    const tenantA = await givenTenant('crossa')
    const tenantB = await givenTenant('crossb')

    // Admin do A, munido do UUID de um membership do B.
    const response = await callApi({
      ...asAdmin(tenantA),
      method: 'PATCH',
      url: `/v1/memberships/${tenantB.membershipId}`,
      payload: { role: 'RECEPTIONIST' },
    })

    // 404, nunca 403: a resposta não revela que o recurso existe em outro lugar.
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_IDENT_001')

    const untouched = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: tenantB.membershipId },
    })
    expect(untouched.roleKey).toBe('TENANT_ADMIN')
  })

  it('não vaza a equipe de outro tenant na listagem', async () => {
    const tenantA = await givenTenant('listaa')
    const tenantB = await givenTenant('listab')
    await givenTeamMember(tenantB, 'GROOMER', 'sotenantb')

    const response = await callApi({
      ...asAdmin(tenantA),
      method: 'GET',
      url: '/v1/memberships',
    })

    const ids = (response.json() as Array<{ userId: string }>).map((row) => row.userId)
    expect(ids).toEqual([tenantA.userId])
  })
})

describe('GET /v1/me', () => {
  it('devolve perfil, vínculos e permissões efetivas do tenant corrente', async () => {
    const session = await givenTenant('perfil')

    const response = await callApi({
      ...asAdmin(session),
      method: 'GET',
      url: '/v1/me',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.user.email).toBe('perfil@petshop.test')
    expect(body.currentTenant.slug).toBe('perfil')
    // `TenantSettings` já nasce com o branding padrão no provisionamento.
    expect(body.primaryColor).toBe('#E34A32')
    expect(body.memberships).toHaveLength(1)
    expect(body.memberships[0]).toMatchObject({ roleKey: 'TENANT_ADMIN', roleLabel: 'Administrador' })
    expect(body.permissions).toContain('tutor:delete')
    expect(body.permVersion).toBe(1)
  })

  it('lista os N vínculos do usuário (RN-01) e responde sem tenant selecionado', async () => {
    const tenantA = await givenTenant('multia')

    // O mesmo usuário vira membro de um segundo tenant.
    const tenantB = await givenTenant('multib')
    await ownerPrisma.membership.create({
      data: { tenantId: tenantB.tenantId, userId: tenantA.userId, roleKey: 'VET', status: 'ACTIVE' },
    })

    // O mesmo usuário, agora com um token **sem Organization** — é o estado de quem
    // acabou de entrar e ainda não escolheu o estabelecimento.
    const response = await callApi({
      ...asStranger(tenantA.clerkUserId),
      method: 'GET',
      url: '/v1/me',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.currentTenant).toBeNull()
    expect(body.primaryColor).toBeNull()
    expect(body.permissions).toEqual([])
    expect(body.memberships).toHaveLength(2)
    expect(body.memberships.map((m: { tenantSlug: string }) => m.tenantSlug).sort()).toEqual([
      'multia',
      'multib',
    ])
  })
})
