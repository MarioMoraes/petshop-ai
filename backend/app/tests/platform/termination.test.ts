import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runTenantPurgeOnce } from '../../src/modules/identity/termination.js'
import {
  setTenantPurgePort,
  type TenantPurgePort,
} from '../../src/modules/identity/purge-port.js'
import { setClerkPort } from '../../src/modules/identity/clerk.js'
import {
  callApi,
  callPlatform,
  closeHarness,
  givenPlatformAdmin,
  givenTenantWithAdmin,
  ownerPrisma,
  platformAuditLines,
  resetDatabase,
  type PlatformUser,
  type TenantWithAdmin,
} from './fixtures.js'

/**
 * MOD-IDENT-10 AC-02 — o encerramento com retenção legal.
 *
 * O porto de expurgo é dublado: cada passo dele é do módulo dono e testado lá (o
 * `anonymizeTutor`, o `wipe` do agente). Aqui o que se prova é o ciclo — encerrar, fechar a
 * porta, reabrir dentro da janela, expurgar depois dela — e que o expurgo não apaga a linha.
 */

const DIA = 24 * 60 * 60 * 1000
const MOTIVO = 'Pedido do dono por e-mail, fechou a loja'

let equipe: PlatformUser
let petshop: TenantWithAdmin
let chamadas: string[]
let orgsApagadas: string[]

beforeEach(async () => {
  await resetDatabase()
  equipe = await givenPlatformAdmin('Equipe Suporte')
  petshop = await givenTenantWithAdmin('petshop-do-joao')
  chamadas = []
  orgsApagadas = []
  const registra =
    (nome: string, valor: unknown = 0) =>
    async () => {
      chamadas.push(nome)
      return valor as never
    }
  const dublê: TenantPurgePort = {
    cancelSubscription: registra('cancelSubscription', true),
    disconnectIntegrations: registra('disconnectIntegrations'),
    anonymizeTutors: registra('anonymizeTutors', 3),
    purgePhotos: registra('purgePhotos', 0),
    purgeAgentConversations: registra('purgeAgentConversations', 0),
    purgeContacts: registra('purgeContacts'),
  }
  setTenantPurgePort(dublê)
  // Só o método que o expurgo usa; o resto do Clerk não é chamado neste arquivo.
  setClerkPort({
    deleteOrganization: async (id: string) => {
      orgsApagadas.push(id)
    },
  } as never)
})

afterEach(() => {
  setTenantPurgePort(null)
  setClerkPort(null)
})

afterAll(closeHarness)

function encerrar(confirmSlug = 'petshop-do-joao', reason = MOTIVO) {
  return callPlatform({
    method: 'POST',
    url: `/platform/v1/tenants/${petshop.tenantId}/terminate`,
    user: equipe,
    payload: { reason, confirmSlug },
  })
}

function reabrir() {
  return callPlatform({
    method: 'POST',
    url: `/platform/v1/tenants/${petshop.tenantId}/reopen`,
    user: equipe,
    payload: { reason: 'Dono desistiu por telefone' },
  })
}

async function encerradoHa(dias: number) {
  await ownerPrisma.tenant.update({
    where: { id: petshop.tenantId },
    data: { terminatedAt: new Date(Date.now() - dias * DIA) },
  })
}

describe('encerrar pelo console', () => {
  it('fecha a conta, cancela a assinatura, desliga as integrações e deixa as duas trilhas', async () => {
    const response = await encerrar()

    expect(response.statusCode).toBe(200)
    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    expect(tenant?.status).toBe('TERMINATED')
    expect(tenant?.terminatedAt).not.toBeNull()
    expect(tenant?.terminationReason).toBe(MOTIVO)
    expect(chamadas).toEqual(['cancelSubscription', 'disconnectIntegrations'])

    const linha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: petshop.tenantId, action: 'tenant.status_changed' },
    })
    expect(linha?.after).toMatchObject({ status: 'TERMINATED' })
    expect(await platformAuditLines('platform.tenant_terminated')).toHaveLength(1)
  })

  it('recusa o endereço que não é o do estabelecimento', async () => {
    const response = await encerrar('petshop-do-jose')
    expect(response.statusCode).toBe(422)
    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    expect(tenant?.status).toBe('ACTIVE')
  })

  it('encerrar duas vezes é 409', async () => {
    await encerrar()
    expect((await encerrar()).statusCode).toBe(409)
  })

  it('a equipe do petshop não lê nada, só o /v1/me', async () => {
    await encerrar()

    const leitura = await callApi({ method: 'GET', url: '/v1/tutors', ...petshop.admin })
    expect(leitura.statusCode).not.toBe(200)
    expect(leitura.json().code).toBe('ERR_IDENT_008')

    const me = await callApi({ method: 'GET', url: '/v1/me', ...petshop.admin })
    expect(me.statusCode).toBe(200)
    expect(me.json().currentTenant.status).toBe('TERMINATED')
  })
})

describe('reabrir', () => {
  it('dentro dos 30 dias volta suspenso', async () => {
    await encerrar()
    await encerradoHa(10)

    const response = await reabrir()
    expect(response.statusCode).toBe(200)
    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    expect(tenant?.status).toBe('SUSPENDED')
    expect(tenant?.terminatedAt).toBeNull()
  })

  it('depois dos 30 dias é recusado', async () => {
    await encerrar()
    await encerradoHa(31)
    expect((await reabrir()).statusCode).toBe(409)
  })
})

describe('o expurgo do D+30', () => {
  it('não toca em quem está na janela', async () => {
    await encerrar()
    await encerradoHa(29)
    chamadas = []

    expect(await runTenantPurgeOnce()).toEqual({ tenants: 0, failed: 0 })
    expect(chamadas).toEqual([])
  })

  it('apaga o dado pessoal, remove a equipe e a chave, e guarda a linha', async () => {
    await encerrar()
    await encerradoHa(31)
    chamadas = []

    expect(await runTenantPurgeOnce()).toEqual({ tenants: 1, failed: 0 })
    expect(chamadas).toEqual([
      'disconnectIntegrations',
      'anonymizeTutors',
      'purgePhotos',
      'purgeAgentConversations',
      'purgeContacts',
    ])
    expect(orgsApagadas).toEqual([petshop.clerkOrgId])

    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    expect(tenant?.status).toBe('TERMINATED')
    expect(tenant?.purgedAt).not.toBeNull()
    expect(tenant?.clerkOrgId).toBeNull()

    const ativos = await ownerPrisma.membership.count({
      where: { tenantId: petshop.tenantId, status: { not: 'REMOVED' } },
    })
    expect(ativos).toBe(0)
    expect(await ownerPrisma.dataKey.count({ where: { tenantId: petshop.tenantId } })).toBe(0)

    // A trilha sobrevive ao expurgo: é o registro de 5 anos.
    const trilha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: petshop.tenantId, action: 'tenant.purged' },
    })
    expect(trilha?.after).toMatchObject({ tutors: 3 })
  })

  it('com os módulos de verdade, o expurgo passa pelas permissões do banco', async () => {
    await encerrar()
    await encerradoHa(31)
    setTenantPurgePort(null)

    expect(await runTenantPurgeOnce()).toEqual({ tenants: 1, failed: 0 })
    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    expect(tenant?.purgedAt).not.toBeNull()
  })

  it('rodar de novo não refaz nada, e o expurgado não reabre', async () => {
    await encerrar()
    await encerradoHa(31)
    await runTenantPurgeOnce()

    expect(await runTenantPurgeOnce()).toEqual({ tenants: 0, failed: 0 })
    expect((await reabrir()).statusCode).toBe(409)
  })
})
