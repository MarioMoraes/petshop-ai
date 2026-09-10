import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callPlatform,
  closeHarness,
  givenPlatformAdmin,
  givenUsageData,
  givenUser,
  ownerPrisma,
  resetDatabase,
  seedTenant,
  type PlatformUser,
} from './fixtures.js'

/** MOD-ADMIN-03 e 07 — o painel de estabelecimentos e as contagens de uso. */

let admin: PlatformUser

beforeEach(async () => {
  await resetDatabase()
  admin = await givenPlatformAdmin('Ana da Plataforma')
})

afterAll(closeHarness)

describe('MOD-ADMIN-03 — painel de tenants', () => {
  it('AC-01: lista com plano, status, datas e as contagens do MOD-ADMIN-07', async () => {
    const tenant = await seedTenant('petshop-alfa')
    await givenUsageData(tenant.tenantId)

    const response = await callPlatform({
      url: '/platform/v1/tenants?status=ACTIVE&page=1&limit=20',
      user: admin,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ total: 1, page: 1, limit: 20 })

    const item = body.data[0]
    expect(item).toMatchObject({ slug: 'petshop-alfa', status: 'ACTIVE', plan: 'STARTER' })
    expect(item.usage).toMatchObject({
      // O inativo não conta; o emitido conta e o pendente não; a enviada conta e a
      // enfileirada não.
      tutors: 1,
      documents: 1,
      messagesThisMonth: 1,
      pets: 0,
      attendances30d: 0,
      photoBytes: 0,
    })
  })

  /**
   * A fronteira do módulo, e ela está no `SELECT`.
   *
   * O painel diz quantos clientes o estabelecimento tem e nada sobre quem eles são — nem
   * quando o denominador é um (AC-02 de MOD-ADMIN-07). O nome que o cenário grava é
   * distinto o bastante para aparecer numa serialização inteira se algum campo o
   * carregasse por engano.
   */
  it('não devolve dado pessoal de tutor, nem com um cliente só', async () => {
    const tenant = await seedTenant('petshop-unico')
    await givenUsageData(tenant.tenantId)

    const response = await callPlatform({ url: '/platform/v1/tenants', user: admin })

    expect(response.body).not.toContain('Cliente Ativo')
    expect(response.body).not.toContain('hash-a-')
  })

  it('AC-02: provisionamento travado aparece no topo, com tentativas e erro', async () => {
    // Criado antes, e mesmo assim primeiro: a ordem é por urgência, não por data.
    const falho = await seedTenant('petshop-travado')
    await ownerPrisma.tenant.update({
      where: { id: falho.tenantId },
      data: {
        status: 'PROVISIONING_FAILED',
        provisioningAttempts: 3,
        provisioningLastError: 'Clerk respondeu 429',
      },
    })
    await seedTenant('petshop-saudavel')

    const response = await callPlatform({ url: '/platform/v1/tenants', user: admin })

    const body = response.json()
    expect(body.data[0]).toMatchObject({
      slug: 'petshop-travado',
      provisioning: { attempts: 3, lastError: 'Clerk respondeu 429' },
    })
    // Quem subiu bem não carrega o bloco: o campo só existe onde significa algo.
    expect(body.data[1]).toMatchObject({ slug: 'petshop-saudavel', provisioning: null })
  })

  it('AC-03: status inventado volta 422 com a lista dos aceitos', async () => {
    const response = await callPlatform({
      url: '/platform/v1/tenants?status=INVENTADO',
      user: admin,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_ADMIN_005')
    expect(response.json().detail).toContain('PROVISIONING_FAILED')
  })

  it('filtra por plano e por texto, e o texto não alcança tutor', async () => {
    const alfa = await seedTenant('banho-e-tosa-alfa')
    await ownerPrisma.tenant.update({ where: { id: alfa.tenantId }, data: { plan: 'PRO' } })
    await seedTenant('petshop-beta')

    const porPlano = await callPlatform({ url: '/platform/v1/tenants?plan=PRO', user: admin })
    expect(porPlano.json().data).toHaveLength(1)

    const porTexto = await callPlatform({ url: '/platform/v1/tenants?q=beta', user: admin })
    expect(porTexto.json().data).toHaveLength(1)
    expect(porTexto.json().data[0].slug).toBe('petshop-beta')
  })

  it('estabelecimento apagado sai da lista', async () => {
    const tenant = await seedTenant('petshop-apagado')
    await ownerPrisma.tenant.update({
      where: { id: tenant.tenantId },
      data: { deletedAt: new Date() },
    })

    const response = await callPlatform({ url: '/platform/v1/tenants', user: admin })
    expect(response.json().total).toBe(0)
  })

  it('quem não é da plataforma recebe 404, como em toda a superfície', async () => {
    const estranho = await givenUser('Dono de Petshop')

    const response = await callPlatform({ url: '/platform/v1/tenants', user: estranho })
    expect(response.statusCode).toBe(404)
  })
})

describe('MOD-ADMIN-07 — uso por tenant', () => {
  it('AC-01: contagens sem grant nenhum', async () => {
    const tenant = await seedTenant('petshop-uso')
    await givenUsageData(tenant.tenantId)

    const response = await callPlatform({
      url: `/platform/v1/tenants/${tenant.tenantId}/usage`,
      user: admin,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      tutors: 1,
      pets: 0,
      attendances30d: 0,
      messagesThisMonth: 1,
      documents: 1,
      photoBytes: 0,
    })
  })

  it('estabelecimento inexistente volta 404', async () => {
    const response = await callPlatform({
      url: '/platform/v1/tenants/00000000-0000-0000-0000-000000000000/usage',
      user: admin,
    })

    expect(response.statusCode).toBe(404)
  })
})
