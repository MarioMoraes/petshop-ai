import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asStranger,
  callApi,
  closeHarness,
  givenClerkUser,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
  type IdentityTenant,
} from './fixtures.js'

/**
 * A marca de lido do sino — `memberships.portal_bookings_seen_at`.
 *
 * É a única coluna de "já vi" do produto, e ela existe por uma razão estreita: cinco
 * das seis linhas do sino contam trabalho parado e caem sozinhas quando alguém o faz;
 * a sexta conta agendamento que o tutor marcou no Portal, que já está confirmado e não
 * tem o que resolver. Sem a marca, esse contador ficaria aceso para sempre.
 *
 * O que os casos abaixo protegem é que ela seja **do vínculo**, e não do usuário: quem
 * atende dois estabelecimentos tem duas caixas de entrada.
 */

async function segundoMembro(
  tenant: IdentityTenant,
  label: string,
): Promise<{ clerkUserId: string; userId: string }> {
  const email = `${label}@petshop.test`
  const clerkUserId = givenClerkUser(email)
  const { encryptPlatform, hashEmail } = await import('@petshop/db')
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId,
      emailEncrypted: encryptPlatform(email),
      emailHash: hashEmail(email),
      fullName: label,
    },
  })
  await ownerPrisma.membership.create({
    data: { tenantId: tenant.tenantId, userId: user.id, roleKey: 'RECEPTIONIST', status: 'ACTIVE' },
  })
  return { clerkUserId, userId: user.id }
}

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
})

afterAll(closeHarness)

describe('a marca de lido do sino', () => {
  it('nasce nula: ninguém abriu o sino ainda', async () => {
    const tenant = await givenTenant('sino-nulo')
    const response = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/me' })

    expect(response.statusCode).toBe(200)
    expect(response.json().portalBookingsSeenAt).toBeNull()
  })

  it('grava o instante e o devolve na leitura seguinte', async () => {
    const tenant = await givenTenant('sino-grava')
    const antes = new Date()

    const marcou = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/me/portal-bookings-seen',
      payload: {},
    })
    expect(marcou.statusCode).toBe(200)

    const seenAt = new Date(marcou.json().seenAt as string)
    expect(seenAt.getTime()).toBeGreaterThanOrEqual(antes.getTime())

    const depois = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/me' })
    expect(depois.json().portalBookingsSeenAt).toBe(seenAt.toISOString())
  })

  /*
   * O caso que justifica a coluna morar em `memberships` e não em `users`. Duas pessoas
   * no mesmo estabelecimento têm caixas de entrada independentes — uma abrir o sino não
   * apaga o aviso da outra.
   */
  it('é de quem abriu, e não do estabelecimento', async () => {
    const tenant = await givenTenant('sino-por-pessoa')
    const colega = await segundoMembro(tenant, 'recepcao')

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/me/portal-bookings-seen',
      payload: {},
    })

    const doColega = await callApi({
      method: 'GET',
      url: '/v1/me',
      clerkUserId: colega.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
    })
    expect(doColega.json().portalBookingsSeenAt).toBeNull()
  })

  /*
   * E o caso que justifica ser por **vínculo**: a mesma pessoa em dois petshops.
   * Uma marca global faria a visita ao primeiro apagar o aviso do segundo.
   */
  it('é por vínculo: quem atende dois petshops tem duas caixas', async () => {
    const primeiro = await givenTenant('sino-um')
    const segundo = await givenTenant('sino-dois')

    // A mesma pessoa, agora também no segundo estabelecimento.
    await ownerPrisma.membership.create({
      data: {
        tenantId: segundo.tenantId,
        userId: primeiro.userId,
        roleKey: 'RECEPTIONIST',
        status: 'ACTIVE',
      },
    })

    await callApi({
      ...asAdmin(primeiro),
      method: 'POST',
      url: '/v1/me/portal-bookings-seen',
      payload: {},
    })

    const noSegundo = await callApi({
      method: 'GET',
      url: '/v1/me',
      clerkUserId: primeiro.clerkUserId,
      clerkOrgId: segundo.clerkOrgId,
    })
    expect(noSegundo.json().portalBookingsSeenAt).toBeNull()
  })

  /*
   * `/v1/me` é a rota que não exige tenant — três fluxos do MOD-IDENT dependem disso.
   * A marca simplesmente não se aplica a quem ainda não é membro de lugar nenhum.
   */
  it('quem não tem estabelecimento lê `/v1/me` sem marca e sem erro', async () => {
    const sozinho = givenClerkUser('sem-tenant@petshop.test')
    const response = await callApi({ ...asStranger(sozinho), method: 'GET', url: '/v1/me' })

    expect(response.statusCode).toBe(200)
    expect(response.json().portalBookingsSeenAt).toBeNull()
  })

  it('marcar sem estabelecimento é recusado — não há vínculo em que gravar', async () => {
    const sozinho = givenClerkUser('sem-tenant-2@petshop.test')
    const response = await callApi({
      ...asStranger(sozinho),
      method: 'POST',
      url: '/v1/me/portal-bookings-seen',
      payload: {},
    })

    expect(response.statusCode).toBe(403)
  })
})
