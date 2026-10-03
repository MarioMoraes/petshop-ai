import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PendingCountsSchema } from '@petshop/shared-types'
import {
  closeHarness,
  getApp,
  givenToken,
  ownerPrisma,
  resetDatabase,
  seedMember,
  seedTenant,
} from './harness.js'

/**
 * `GET /v1/me/pending` — o sino do Admin numa chamada só (`src/gateway/pending.ts`).
 *
 * O que se protege: que a resposta agregada seja **a mesma** que as nove rotas dariam
 * chamadas uma a uma, que quem não pode ver uma fonte receba `null` sem deixar rastro de
 * negação na trilha, e que a navegação conte **uma** vez no rate limit.
 */

beforeEach(resetDatabase)
afterAll(closeHarness)

async function get(url: string, token: string) {
  const app = await getApp()
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
}

async function membro(role: string, plan: 'STARTER' | 'PRO' = 'PRO') {
  const tenant = await seedTenant(`sino-${role.toLowerCase().replace(/_/g, '-')}`, 'ACTIVE', plan)
  // A DEK que o provisionamento cria: sem ela a fila do agente não abre (`openCipher`).
  const { createTenantKey, withTenant } = await import('@petshop/db')
  await withTenant(tenant.tenantId, (tx) => createTenantKey(tx, tenant.tenantId))
  const member = await seedMember(tenant.tenantId, role)
  const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })
  return { tenant, token }
}

describe('GET /v1/me/pending', () => {
  it('dá o que as nove rotas dariam, uma a uma', async () => {
    const { token } = await membro('TENANT_ADMIN')

    const agregado = await get('/v1/me/pending', token)
    expect(agregado.statusCode).toBe(200)
    const corpo = PendingCountsSchema.parse(agregado.json())

    const direto = async (url: string) => {
      const resposta = await get(url, token)
      expect(resposta.statusCode, url).toBe(200)
      return resposta.json()
    }

    expect(corpo.pendingApprovals).toEqual(await direto('/v1/appointments/pending-count'))
    expect(corpo.newPortalBookings).toEqual(await direto('/v1/appointments/portal-new-count'))
    expect(corpo.deletionRequests).toBe((await direto('/v1/tutors/deletion-requests/count')).total)
    expect(corpo.siteLeads).toBe((await direto('/v1/site/leads/count')).newCount)
    expect(corpo.overdueTutors).toBe(
      (await direto('/v1/tutors?tag=INADIMPLENTE&limit=1&page=1')).total,
    )
    expect(corpo.agentHandoffs).toBe(
      (await direto('/v1/agent/conversations?status=HANDOFF&waitingOverMinutes=10&limit=1')).total,
    )
    expect(corpo.deadMessages).toBe(0)
    expect(corpo.inventory).toEqual(await direto('/v1/inventory/alerts'))
    expect(corpo.cash).toEqual(await direto('/v1/cash/alerts'))
  })

  it('o recurso fora do plano sai `null`, sem chamar a rota que responderia 402', async () => {
    const { token } = await membro('TENANT_ADMIN', 'STARTER')

    const corpo = PendingCountsSchema.parse((await get('/v1/me/pending', token)).json())

    expect(corpo.inventory).toBeNull()
    expect(corpo.cash).toBeNull()
    expect(corpo.pendingApprovals).not.toBeNull()
  })

  it('sem a permissão, `null` — e nenhuma negação gravada na trilha', async () => {
    const { tenant, token } = await membro('BATHER')

    const corpo = PendingCountsSchema.parse((await get('/v1/me/pending', token)).json())

    expect(corpo.deletionRequests).toBeNull()
    expect(corpo.siteLeads).toBeNull()
    expect(corpo.deadMessages).toBeNull()
    expect(corpo.agentHandoffs).toBeNull()

    const negacoes = await ownerPrisma.securityEvent.count({
      where: { tenantId: tenant.tenantId, type: 'PERMISSION_DENIED' },
    })
    expect(negacoes).toBe(0)
  })

  it('conta uma vez no rate limit, e não nove', async () => {
    const { token } = await membro('TENANT_ADMIN')

    const primeira = await get('/v1/me/pending', token)
    const segunda = await get('/v1/me/pending', token)

    const restante = (r: typeof primeira) => Number(r.headers['x-ratelimit-remaining'])
    expect(restante(primeira) - restante(segunda)).toBe(1)
  })

  it('a marca das chamadas internas não vale vinda de fora', async () => {
    const { token } = await membro('TENANT_ADMIN')
    const app = await getApp()

    const forjada = await app.inject({
      method: 'GET',
      url: '/v1/me/pending',
      headers: { authorization: `Bearer ${token}`, 'x-petshop-internal-call': 'chute' },
    })
    const normal = await get('/v1/me/pending', token)

    // Contou as duas: o chute não abriu a isenção.
    expect(Number(forjada.headers['x-ratelimit-remaining']) - 1).toBe(
      Number(normal.headers['x-ratelimit-remaining']),
    )
  })
})
