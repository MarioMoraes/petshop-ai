import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callPlatform,
  closeHarness,
  givenPlatformAdmin,
  givenUser,
  ownerPrisma,
  platformAuditLines,
  resetDatabase,
  seedMember,
  seedTenant,
  type PlatformUser,
} from './fixtures.js'

/** MOD-ADMIN-01 — o papel de plataforma. */

let admin: PlatformUser

beforeEach(async () => {
  await resetDatabase()
  admin = await givenPlatformAdmin('Ana da Plataforma')
})

afterAll(closeHarness)

describe('MOD-ADMIN-01 — quem alcança a superfície da plataforma', () => {
  it('AC-01: quem tem vínculo vivo e token sem Organization entra', async () => {
    const response = await callPlatform({ url: '/platform/v1/admins', user: admin })

    expect(response.statusCode).toBe(200)
    expect(response.json().items).toHaveLength(1)
    expect(response.json().items[0]).toMatchObject({ fullName: 'Ana da Plataforma' })
  })

  /**
   * AC-02 — **404, e não 403**, e é a decisão que atravessa o módulo.
   *
   * Um 403 confirmaria a quem está varrendo que a superfície da plataforma existe. Quem
   * não é da equipe não recebe a informação de que há uma equipe.
   */
  it('AC-02: quem não é da plataforma recebe 404, não 403', async () => {
    const estranho = await givenUser('Dono de Petshop')

    const response = await callPlatform({ url: '/platform/v1/admins', user: estranho })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_ADMIN_001')
  })

  /**
   * AC-03 — o administrador que também é dono de petshop.
   *
   * O crachá de plataforma **não** se soma ao papel de tenant. Com Organization no token a
   * sessão é a da equipe daquele estabelecimento, e a superfície da plataforma responde
   * como se não existisse — é a mesma fronteira que o Portal desenha com o header de host.
   */
  it('AC-03: token com Organization não alcança a plataforma, nem sendo admin dela', async () => {
    const tenant = await seedTenant('petshop-do-admin')
    await ownerPrisma.membership.create({
      data: { tenantId: tenant.tenantId, userId: admin.userId, roleKey: 'TENANT_ADMIN' },
    })

    const response = await callPlatform({
      url: '/platform/v1/admins',
      user: admin,
      clerkOrgId: tenant.clerkOrgId,
    })

    expect(response.statusCode).toBe(404)
  })

  it('vínculo revogado deixa de alcançar', async () => {
    await ownerPrisma.platformAdmin.updateMany({
      where: { userId: admin.userId },
      data: { revokedAt: new Date(), revokedBy: admin.userId },
    })

    const response = await callPlatform({ url: '/platform/v1/admins', user: admin })
    expect(response.statusCode).toBe(404)
  })

  it('a sessão de plataforma não tem tenant, e o Admin de tenant recusa', async () => {
    const response = await callPlatform({ url: '/v1/tutors', user: admin })

    // Sem `tenantId` no contexto, `requireTenantContext` recusa — o papel `SUPER_ADMIN`
    // dá as permissões, e nenhuma delas nomeia um estabelecimento.
    expect(response.statusCode).toBe(403)
  })
})

describe('MOD-ADMIN-01 — conceder e revogar', () => {
  it('AC-04: concede a quem já tem espelho local e registra na trilha da plataforma', async () => {
    const novo = await givenUser('Bruno do Suporte')

    const response = await callPlatform({
      method: 'POST',
      url: '/platform/v1/admins',
      user: admin,
      payload: { email: novo.email },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ userId: novo.userId, grantedBy: admin.userId })

    const linhas = await platformAuditLines('platform.admin_granted')
    expect(linhas).toHaveLength(1)
    // `tenant_id` nulo: é ação da plataforma, e atribuí-la a um estabelecimento a
    // esconderia por RLS de quem precisa auditá-la.
    expect(linhas[0]?.tenantId).toBeNull()
    expect(linhas[0]?.actorUserId).toBe(admin.userId)
  })

  /**
   * O espelho local nasce no primeiro acesso ao produto.
   *
   * Conceder a quem nunca entrou criaria uma linha apontando para ninguém — e a mensagem
   * diz isso em vez de "não encontrado", que mandaria a pessoa procurar no lugar errado.
   */
  it('concede só a quem já acessou o produto uma vez', async () => {
    const response = await callPlatform({
      method: 'POST',
      url: '/platform/v1/admins',
      user: admin,
      payload: { email: 'ninguem@petshopai.com' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_ADMIN_005')
    expect(response.json().detail).toContain('ainda não acessou')
  })

  it('conceder duas vezes à mesma pessoa é recusado', async () => {
    const novo = await givenUser()
    const payload = { email: novo.email }

    await callPlatform({ method: 'POST', url: '/platform/v1/admins', user: admin, payload })
    const segunda = await callPlatform({
      method: 'POST',
      url: '/platform/v1/admins',
      user: admin,
      payload,
    })

    expect(segunda.statusCode).toBe(422)
    expect(await ownerPrisma.platformAdmin.count({ where: { revokedAt: null } })).toBe(2)
  })

  it('revoga, e a revogação é soft — a linha fica para a trilha', async () => {
    const outro = await givenPlatformAdmin('Carla')
    const alvo = await ownerPrisma.platformAdmin.findFirstOrThrow({
      where: { userId: outro.userId },
    })

    const response = await callPlatform({
      method: 'DELETE',
      url: `/platform/v1/admins/${alvo.id}`,
      user: admin,
    })

    expect(response.statusCode).toBe(204)

    const linha = await ownerPrisma.platformAdmin.findUniqueOrThrow({ where: { id: alvo.id } })
    expect(linha.revokedAt).not.toBeNull()
    expect(linha.revokedBy).toBe(admin.userId)
    expect(await platformAuditLines('platform.admin_revoked')).toHaveLength(1)
  })

  /**
   * AC-05 — a mesma guarda do último `TENANT_ADMIN`, pela mesma razão.
   *
   * Uma plataforma sem administrador não tem como voltar a ter um: a concessão exige um
   * administrador vivo, e a única saída seria `psql`.
   */
  it('AC-05: o último administrador não se revoga', async () => {
    const alvo = await ownerPrisma.platformAdmin.findFirstOrThrow({
      where: { userId: admin.userId },
    })

    const response = await callPlatform({
      method: 'DELETE',
      url: `/platform/v1/admins/${alvo.id}`,
      user: admin,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_ADMIN_004')
    expect(await ownerPrisma.platformAdmin.count({ where: { revokedAt: null } })).toBe(1)
  })

  /**
   * Conceder de novo a quem foi revogado é o caminho normal.
   *
   * A unicidade é **parcial** (`idx_platform_admins_vivo`): o que não pode existir é a
   * segunda linha viva. Unicidade total impediria o histórico.
   */
  it('quem foi revogado pode ser concedido de novo, e o histórico fica', async () => {
    const outro = await givenPlatformAdmin()
    const alvo = await ownerPrisma.platformAdmin.findFirstOrThrow({
      where: { userId: outro.userId },
    })

    await callPlatform({ method: 'DELETE', url: `/platform/v1/admins/${alvo.id}`, user: admin })
    const denovo = await callPlatform({
      method: 'POST',
      url: '/platform/v1/admins',
      user: admin,
      payload: { email: outro.email },
    })

    expect(denovo.statusCode).toBe(201)
    expect(await ownerPrisma.platformAdmin.count({ where: { userId: outro.userId } })).toBe(2)
  })

  it('quem não é da plataforma não concede nem revoga', async () => {
    const estranho = await givenUser()
    const novo = await givenUser()

    const response = await callPlatform({
      method: 'POST',
      url: '/platform/v1/admins',
      user: estranho,
      payload: { email: novo.email },
    })

    expect(response.statusCode).toBe(404)
    expect(await ownerPrisma.platformAdmin.count({ where: { revokedAt: null } })).toBe(1)
  })
})

describe('MOD-ADMIN-01 — o que a superfície não empresta', () => {
  /**
   * A equipe de um petshop não vira plataforma por ter `TENANT_ADMIN`.
   *
   * O papel de tenant e o de plataforma vivem em tabelas diferentes de propósito: um
   * `membership` com `role_key = 'TENANT_ADMIN'` não é linha em `platform_admins`, e a
   * matriz de permissões não é o que decide quem alcança `/platform/v1`.
   */
  it('TENANT_ADMIN de um estabelecimento não alcança a plataforma', async () => {
    const tenant = await seedTenant('petshop-comum')
    const membro = await seedMember(tenant.tenantId, 'TENANT_ADMIN')

    const response = await callPlatform({
      url: '/platform/v1/admins',
      user: { userId: membro.userId, clerkUserId: membro.clerkUserId, email: '' },
    })

    expect(response.statusCode).toBe(404)
  })
})
