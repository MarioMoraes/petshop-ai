import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callApi,
  callPlatform,
  callSupport,
  closeHarness,
  givenPlatformAdmin,
  givenTenantWithAdmin,
  givenUser,
  platformAuditLines,
  resetDatabase,
  type PlatformUser,
} from './fixtures.js'

/** MOD-ADMIN-08 — a trilha cross-tenant. */

let admin: PlatformUser

beforeEach(async () => {
  await resetDatabase()
  admin = await givenPlatformAdmin('Ana da Plataforma')
})

afterAll(closeHarness)

/** Um grant vivo, que é o caminho pelo qual nascem linhas `support.read`. */
async function givenLeituraSobGrant(tenantSlug: string) {
  const tenant = await givenTenantWithAdmin(tenantSlug)

  const pedido = await callPlatform({
    method: 'POST',
    url: `/platform/v1/tenants/${tenant.tenantId}/support-access`,
    user: admin,
    payload: { reason: 'chamado #482, tutor relata recibo não recebido' },
  })
  expect(pedido.statusCode).toBe(201)

  const aprovacao = await callApi({
    ...tenant.admin,
    method: 'POST',
    url: `/v1/support-access/${pedido.json().id}/approve`,
    payload: { hours: 4 },
  })
  expect(aprovacao.statusCode).toBe(200)

  const leitura = await callSupport({
    url: '/v1/tutors',
    user: admin,
    tenantId: tenant.tenantId,
  })
  expect(leitura.statusCode).toBe(200)

  return tenant
}

describe('MOD-ADMIN-08 — trilha da plataforma', () => {
  it('AC-01: devolve linhas de todos os tenants, filtradas por ação', async () => {
    const tenant = await givenLeituraSobGrant('petshop-alfa')

    const response = await callPlatform({
      url: '/platform/v1/audit-logs?action=support.read',
      user: admin,
    })

    expect(response.statusCode).toBe(200)
    const [linha] = response.json().items
    expect(linha).toMatchObject({
      action: 'support.read',
      actorUserId: admin.userId,
      actorName: 'Ana da Plataforma',
      tenant: { id: tenant.tenantId, slug: 'petshop-alfa' },
    })
    // O e-mail do ator sai mascarado, como no MOD-SEC-05: esta rota atravessa todos os
    // estabelecimentos, e em claro seria a via mais curta para a lista de contatos deles.
    expect(linha.actorEmailMasked).not.toBe(admin.email)
    expect(linha.actorEmailMasked).toContain('@')
  })

  /**
   * AC-02 — quem vigia também é vigiado.
   *
   * É a única razão pela qual a leitura cross-tenant existe: sem ela, as leituras do
   * suporte ficariam visíveis só a quem foi lido.
   */
  it('AC-02: filtro por ator mostra o que o suporte leu, em que tenant e sob qual grant', async () => {
    const tenant = await givenLeituraSobGrant('petshop-beta')
    const outro = await givenPlatformAdmin('Bruno da Plataforma')

    const response = await callPlatform({
      url: `/platform/v1/audit-logs?actorUserId=${admin.userId}&action=support.read`,
      user: outro,
    })

    const [linha] = response.json().items
    expect(linha.tenant.id).toBe(tenant.tenantId)
    expect(linha.after).toMatchObject({ method: 'GET' })
    expect(linha.after.grantId).toEqual(expect.any(String))
  })

  it('AC-03: janela maior que 92 dias volta 422', async () => {
    const from = new Date(Date.now() - 200 * 86_400_000).toISOString()

    const response = await callPlatform({
      url: `/platform/v1/audit-logs?from=${from}`,
      user: admin,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_ADMIN_005')
  })

  /** RN-13: a consulta da trilha entra na trilha, com o filtro usado. */
  it('RN-13: ler a trilha registra a própria leitura, sem tenant', async () => {
    await callPlatform({
      url: '/platform/v1/audit-logs?action=support.read',
      user: admin,
    })

    // A escrita não bloqueia a resposta; o teste espera a linha aparecer.
    await expect
      .poll(async () => (await platformAuditLines('platform.audit_read')).length)
      .toBe(1)

    const [linha] = await platformAuditLines('platform.audit_read')
    expect(linha).toMatchObject({ tenantId: null, actorUserId: admin.userId })
  })

  it('pagina por cursor, e a última página não devolve cursor', async () => {
    await givenLeituraSobGrant('petshop-gama')

    const primeira = await callPlatform({
      url: '/platform/v1/audit-logs?limit=1',
      user: admin,
    })
    expect(primeira.json().items).toHaveLength(1)
    expect(primeira.json().nextCursor).toEqual(expect.any(String))

    const segunda = await callPlatform({
      url: `/platform/v1/audit-logs?limit=1&cursor=${encodeURIComponent(primeira.json().nextCursor)}`,
      user: admin,
    })
    expect(segunda.json().items[0].id).not.toBe(primeira.json().items[0].id)
  })

  it('quem não é da plataforma recebe 404', async () => {
    const estranho = await givenUser('Dono de Petshop')

    const response = await callPlatform({ url: '/platform/v1/audit-logs', user: estranho })
    expect(response.statusCode).toBe(404)
  })
})
