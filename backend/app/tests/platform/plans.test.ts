import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PLAN_GATES } from '../../src/gateway/plan-gates.js'
import {
  callApi,
  callPlatform,
  callPublic,
  closeHarness,
  getApp,
  givenPlatformAdmin,
  givenTenantWithAdmin,
  ownerPrisma,
  platformAuditLines,
  resetDatabase,
  type PlatformUser,
  type TenantWithAdmin,
} from './fixtures.js'

/**
 * A camada comercial, fatia 2 — o plano decide o que responde.
 *
 * O estabelecimento de `givenTenantWithAdmin` nasce no `STARTER`, que é justamente o
 * caso que importa: o menor plano, sem nenhum recurso pago.
 */

let equipe: PlatformUser
let petshop: TenantWithAdmin

const MOTIVO = 'Contratou o Pro por telefone em 17/09'

beforeEach(async () => {
  await resetDatabase()
  equipe = await givenPlatformAdmin('Equipe Comercial')
  petshop = await givenTenantWithAdmin('petshop-do-joao')
})

afterAll(closeHarness)

function mudarPlano(plan: string, reason = MOTIVO, tenantId = petshop.tenantId) {
  return callPlatform({
    method: 'PATCH',
    url: `/platform/v1/tenants/${tenantId}/plan`,
    user: equipe,
    payload: { plan, reason },
  })
}

describe('a troca de plano pelo console', () => {
  it('grava o plano e deixa o motivo nas duas trilhas', async () => {
    const response = await mudarPlano('PRO')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ tenantId: petshop.tenantId, plan: 'PRO' })

    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    expect(tenant?.plan).toBe('PRO')

    // A do estabelecimento é a que responde "por que perdi o Taxi Dog?".
    const linha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: petshop.tenantId, action: 'tenant.plan_changed' },
    })
    expect(linha?.actorUserId).toBe(equipe.userId)
    expect(linha?.before).toEqual({ plan: 'STARTER' })
    expect(linha?.after).toMatchObject({ plan: 'PRO', reason: MOTIVO })

    expect(await platformAuditLines('platform.tenant_plan_changed')).toHaveLength(1)
  })

  it('recusa o motivo curto, o plano inexistente e o plano que já é o atual', async () => {
    expect((await mudarPlano('PRO', 'upgrade')).statusCode).toBe(422)
    expect((await mudarPlano('GOLD')).statusCode).toBe(422)

    const mesmo = await mudarPlano('STARTER')
    expect(mesmo.statusCode).toBe(409)
    expect(mesmo.json().code).toBe('ERR_ADMIN_006')
  })

  it('estabelecimento que não existe é 404', async () => {
    const response = await mudarPlano('PRO', MOTIVO, '00000000-0000-4000-8000-000000000000')
    expect(response.statusCode).toBe(404)
  })

  it('o administrador do petshop não alcança a rota', async () => {
    // A sessão dele tem Organization, e a superfície da plataforma responde 404 a ela.
    const response = await callPlatform({
      method: 'PATCH',
      url: `/platform/v1/tenants/${petshop.tenantId}/plan`,
      user: {
        userId: petshop.adminUserId,
        clerkUserId: petshop.admin.clerkUserId,
        email: 'admin@petshop.test',
      },
      clerkOrgId: petshop.clerkOrgId,
      payload: { plan: 'ENTERPRISE', reason: MOTIVO },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('o bloqueio das rotas da equipe', () => {
  it('Starter recebe 402 com o plano que libera, e a troca libera na requisição seguinte', async () => {
    const antes = await callApi({ ...petshop.admin, method: 'GET', url: '/v1/taxi/settings' })

    expect(antes.statusCode).toBe(402)
    expect(antes.json()).toMatchObject({
      code: 'ERR_PLAN_001',
      feature: 'TAXI',
      currentPlan: 'STARTER',
      requiredPlan: 'PRO',
    })

    await mudarPlano('PRO')

    const depois = await callApi({ ...petshop.admin, method: 'GET', url: '/v1/taxi/settings' })
    expect(depois.statusCode).toBe(200)
  })

  it('a operação do Starter continua respondendo', async () => {
    const response = await callApi({ ...petshop.admin, method: 'GET', url: '/v1/crm/automations' })
    expect(response.statusCode).toBe(200)
  })

  it('o painel de qualidade pede o Enterprise mesmo com o agente liberado', async () => {
    await mudarPlano('PRO')

    const config = await callApi({ ...petshop.admin, method: 'GET', url: '/v1/agent/settings' })
    expect(config.statusCode).toBe(200)

    const stats = await callApi({ ...petshop.admin, method: 'GET', url: '/v1/agent/stats' })
    expect(stats.statusCode).toBe(402)
    expect(stats.json()).toMatchObject({ feature: 'AI_QUALITY', requiredPlan: 'ENTERPRISE' })
  })

  it('persona e tom do agente pedem o Enterprise; a janela não', async () => {
    await mudarPlano('PRO')

    const janela = await callApi({
      ...petshop.admin,
      method: 'PATCH',
      url: '/v1/agent/settings',
      payload: { opensAt: '09:00' },
    })
    expect(janela.statusCode).toBe(200)

    const persona = await callApi({
      ...petshop.admin,
      method: 'PATCH',
      url: '/v1/agent/settings',
      payload: { personaName: 'Lia' },
    })
    expect(persona.statusCode).toBe(402)
    expect(persona.json().feature).toBe('AI_PERSONA')
  })

  it('a régua de cobrança é do Pro, e o lembrete, que divide a rota com ela, não', async () => {
    const lembrete = await callApi({
      ...petshop.admin,
      method: 'PATCH',
      url: '/v1/crm/automations/appointment_reminder',
      payload: { enabled: false },
    })
    expect(lembrete.statusCode).toBe(200)

    const regua = await callApi({
      ...petshop.admin,
      method: 'PATCH',
      url: '/v1/crm/automations/dunning',
      payload: { enabled: true },
    })
    expect(regua.statusCode).toBe(402)
    expect(regua.json().feature).toBe('CAMPAIGNS')
  })
})

describe('as superfícies do cliente do petshop', () => {
  it('o Portal de um Starter responde como estabelecimento que não existe', async () => {
    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    // A tela de login do Portal monta a identidade visual de `tenant_settings`, que o
    // `seedTenant` não cria.
    await ownerPrisma.tenantSettings.create({
      data: { tenantId: petshop.tenantId, branding: {}, businessHours: {} },
    })
    const pedir = () =>
      callPublic({
        method: 'GET',
        url: '/portal/v1/tenant',
        headers: { 'x-petshop-tenant-slug': tenant!.slug },
      })

    const starter = await pedir()
    expect(starter.statusCode).toBe(404)
    expect(starter.json().code).toBe('ERR_PORTAL_001')

    await mudarPlano('PRO')
    expect((await pedir()).statusCode).toBe(200)
  })

  it('o site de um Starter é 404, e nunca "recurso fora do plano"', async () => {
    const tenant = await ownerPrisma.tenant.findUnique({ where: { id: petshop.tenantId } })
    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site?slug=${tenant!.slug}`,
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).not.toBe('ERR_PLAN_001')
  })
})

/**
 * Os caminhos completos, a partir da árvore que o Fastify imprime.
 *
 * A árvore é de prefixo: `/v1/messaging/` numa linha e `whatsapp` noutra, abaixo dela. Cada
 * nível ocupa quatro colunas (`│   `, `├── `), e o caminho é a soma dos rótulos do topo
 * até a linha. Com mais de um método registrado, o Fastify imprime uma árvore por método.
 */
function caminhosRegistrados(arvore: string): string[] {
  const pilha: string[] = []
  const caminhos: string[] = []

  for (const linha of arvore.split('\n')) {
    const marca = linha.search(/[├└]── /)
    if (marca < 0) continue
    const nivel = marca / 4
    // A raiz de cada árvore de método sai como `(empty root node)`, e não é segmento.
    const rotulo = linha
      .slice(marca + 4)
      .replace(/^\(empty root node\)$/, '')
      .replace(/ \(.*\)$/, '')
    pilha.length = nivel
    pilha.push(rotulo)
    caminhos.push(pilha.join(''))
  }

  return caminhos
}

describe('a tabela de prefixos', () => {
  it('todo prefixo bloqueado casa com ao menos uma rota registrada', async () => {
    // Um prefixo com erro de digitação não bloquearia nada, e nada acusaria.
    const app = await getApp()
    const caminhos = caminhosRegistrados(app.printRoutes())

    for (const gate of PLAN_GATES) {
      const casa = caminhos.some(
        (caminho) => caminho === gate.prefix || caminho.startsWith(`${gate.prefix}/`),
      )
      expect(casa, gate.prefix).toBe(true)
    }
  })
})
