import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AUDIT_QUERY_MAX_DAYS } from '@petshop/shared-types'
import {
  asRole,
  callApi,
  closeHarness,
  givenSecurityTenant,
  ownerPrisma,
  resetDatabase,
  seedAuditLog,
  seedSecurityEvent,
} from './fixtures.js'

/** MOD-SEC-04, 05 e 07 — a trilha que passou a ser legível, e os emissores que faltavam. */

beforeEach(resetDatabase)
afterAll(closeHarness)

const HOJE = new Date()
const ONTEM = new Date(Date.now() - 86_400_000)

describe('MOD-SEC-04 — leitura da trilha de auditoria', () => {
  it('AC-01: devolve as linhas do próprio tenant, mais recentes primeiro', async () => {
    const fixture = await givenSecurityTenant('trilha')
    await seedAuditLog({ tenantId: fixture.tenantId, createdAt: ONTEM, action: 'tutor.criado' })
    await seedAuditLog({ tenantId: fixture.tenantId, createdAt: HOJE, action: 'pet.criado' })

    const response = await callApi({ ...fixture.admin, method: 'GET', url: '/v1/audit-logs' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.items.map((row: { action: string }) => row.action)).toEqual([
      'pet.criado',
      'tutor.criado',
    ])
    expect(body.nextCursor).toBeNull()
  })

  it('AC-02: filtra por entidade e desfecho', async () => {
    const fixture = await givenSecurityTenant('filtro')
    await seedAuditLog({ tenantId: fixture.tenantId, createdAt: HOJE, action: 'tutor.criado' })
    await ownerPrisma.auditLog.create({
      data: {
        tenantId: fixture.tenantId,
        action: 'auth.permission_denied',
        entity: 'permission',
        entityId: 'tutor:delete',
        outcome: 'DENIED',
      },
    })

    const negadas = await callApi({
      ...fixture.admin,
      method: 'GET',
      url: '/v1/audit-logs?outcome=DENIED',
    })
    expect(negadas.json().items).toHaveLength(1)
    expect(negadas.json().items[0].entityId).toBe('tutor:delete')

    const porEntidade = await callApi({
      ...fixture.admin,
      method: 'GET',
      url: '/v1/audit-logs?entity=permission',
    })
    expect(porEntidade.json().items).toHaveLength(1)
  })

  it('AC-02: recusa janela maior que o teto', async () => {
    const fixture = await givenSecurityTenant('janela')
    const from = new Date(Date.now() - (AUDIT_QUERY_MAX_DAYS + 1) * 86_400_000).toISOString()

    const response = await callApi({
      ...fixture.admin,
      method: 'GET',
      url: `/v1/audit-logs?from=${from}&to=${new Date().toISOString()}`,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_SEC_002')
  })

  it('AC-03: quem não tem `audit:read` recebe 403 e vira registro', async () => {
    const fixture = await givenSecurityTenant('semaudit')
    const receptionist = await asRole(fixture, 'RECEPTIONIST')

    const response = await callApi({ ...receptionist, method: 'GET', url: '/v1/audit-logs' })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_SEC_003')

    const negada = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId, outcome: 'DENIED' },
    })
    expect(negada?.entityId).toBe('audit:read')
  })

  it('AC-04: filtrar por recurso de outro tenant devolve lista vazia, não 403', async () => {
    const a = await givenSecurityTenant('trilhaa')
    const b = await givenSecurityTenant('trilhab')
    const alheio = await seedAuditLog({ tenantId: b.tenantId, createdAt: HOJE })

    const response = await callApi({
      ...a.admin,
      method: 'GET',
      url: `/v1/audit-logs?entityId=${alheio}`,
    })

    // 200 com nada. A resposta não revela que a linha existe noutro estabelecimento.
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toHaveLength(0)
  })

  it('AC-05: o que `sanitize` redigiu na escrita continua redigido', async () => {
    const fixture = await givenSecurityTenant('redacao')
    await ownerPrisma.auditLog.create({
      data: {
        tenantId: fixture.tenantId,
        action: 'tutor.atualizado',
        entity: 'tutor',
        after: { fullName: 'Maria', phone: '[redacted]' },
      },
    })

    const response = await callApi({ ...fixture.admin, method: 'GET', url: '/v1/audit-logs' })
    expect(response.json().items[0].after).toEqual({ fullName: 'Maria', phone: '[redacted]' })
  })

  it('AC-06: o ator vem resolvido, com o e-mail mascarado', async () => {
    const fixture = await givenSecurityTenant('ator')
    await seedAuditLog({
      tenantId: fixture.tenantId,
      createdAt: HOJE,
      actorUserId: fixture.adminUserId,
    })
    await seedAuditLog({ tenantId: fixture.tenantId, createdAt: ONTEM, actorUserId: null })

    const items = (await callApi({ ...fixture.admin, method: 'GET', url: '/v1/audit-logs' })).json()
      .items

    expect(items[0]).toMatchObject({ actorKind: 'USER', actorName: 'Membro de Teste' })
    expect(items[0].actorEmailMasked).toContain('@petshop.test')
    expect(items[0].actorEmailMasked).toContain('*')
    // Linha de job: não há pessoa a nomear.
    expect(items[1]).toMatchObject({ actorKind: 'SYSTEM', actorUserId: null, actorName: null })
  })

  it('pagina por cursor, sem repetir nem pular linha', async () => {
    const fixture = await givenSecurityTenant('cursor')
    for (let i = 0; i < 5; i += 1) {
      await seedAuditLog({
        tenantId: fixture.tenantId,
        createdAt: new Date(Date.now() - i * 60_000),
        action: `acao.${i}`,
      })
    }

    const primeira = await callApi({
      ...fixture.admin,
      method: 'GET',
      url: '/v1/audit-logs?limit=2',
    })
    expect(primeira.json().items).toHaveLength(2)
    expect(primeira.json().nextCursor).toBeTruthy()

    const segunda = await callApi({
      ...fixture.admin,
      method: 'GET',
      url: `/v1/audit-logs?limit=2&cursor=${encodeURIComponent(primeira.json().nextCursor)}`,
    })

    const vistas = [...primeira.json().items, ...segunda.json().items].map(
      (row: { action: string }) => row.action,
    )
    expect(vistas).toEqual(['acao.0', 'acao.1', 'acao.2', 'acao.3'])
  })
})

describe('MOD-SEC-05 — leitura dos eventos de segurança', () => {
  it('AC-01: lista os eventos do tenant, filtrável por tipo', async () => {
    const fixture = await givenSecurityTenant('eventos')
    await seedSecurityEvent({ tenantId: fixture.tenantId, createdAt: HOJE, type: 'LOGIN_FAILED' })
    await seedSecurityEvent({
      tenantId: fixture.tenantId,
      createdAt: HOJE,
      type: 'PERMISSION_DENIED',
    })

    const todos = await callApi({ ...fixture.admin, method: 'GET', url: '/v1/security-events' })
    expect(todos.json().items).toHaveLength(2)

    const filtrado = await callApi({
      ...fixture.admin,
      method: 'GET',
      url: '/v1/security-events?type=LOGIN_FAILED',
    })
    expect(filtrado.json().items).toHaveLength(1)
  })

  it('AC-02: `summary` devolve a contagem por tipo, ordenada', async () => {
    const fixture = await givenSecurityTenant('resumo')
    for (let i = 0; i < 3; i += 1) {
      await seedSecurityEvent({
        tenantId: fixture.tenantId,
        createdAt: HOJE,
        type: 'PERMISSION_DENIED',
      })
    }
    await seedSecurityEvent({ tenantId: fixture.tenantId, createdAt: HOJE, type: 'LOGIN_FAILED' })

    const response = await callApi({
      ...fixture.admin,
      method: 'GET',
      url: '/v1/security-events?summary=true',
    })

    expect(response.json().items).toEqual([
      { type: 'PERMISSION_DENIED', count: 3 },
      { type: 'LOGIN_FAILED', count: 1 },
    ])
  })

  it('AC-03: a linha de plataforma não aparece para tenant nenhum', async () => {
    const fixture = await givenSecurityTenant('plataforma')
    await seedSecurityEvent({ tenantId: null, createdAt: HOJE, type: 'CROSS_TENANT_ATTEMPT' })

    const response = await callApi({ ...fixture.admin, method: 'GET', url: '/v1/security-events' })
    expect(response.json().items).toHaveLength(0)

    // Mas ela existe: quem a lê é a plataforma, por `app_maintenance`.
    expect(await ownerPrisma.securityEvent.count({ where: { tenantId: null } })).toBe(1)
  })
})

describe('MOD-SEC-07 — os emissores que faltavam', () => {
  /**
   * AC-01. O `proxy.ts` descarta os headers `x-petshop-*` que chegam de fora, e é isso
   * que torna a tentativa inofensiva — mas descartar em silêncio também a torna
   * invisível. Uma requisição legítima nunca carrega esse header pela porta de fora.
   */
  it('AC-01: cliente que se declara de outro estabelecimento vira CROSS_TENANT_ATTEMPT', async () => {
    const a = await givenSecurityTenant('forjaa')
    const b = await givenSecurityTenant('forjab')

    const response = await callApi({
      ...a.admin,
      method: 'GET',
      url: '/v1/professionals',
      headers: { 'x-petshop-tenant-id': b.tenantId },
    })

    // O header é ignorado: a requisição segue com o tenant que o gateway resolveu.
    expect(response.statusCode).toBe(200)

    const evento = await ownerPrisma.securityEvent.findFirst({
      where: { type: 'CROSS_TENANT_ATTEMPT' },
    })
    expect(evento?.tenantId).toBe(a.tenantId)
    expect(evento?.targetId).toBe(b.tenantId)
    expect(evento?.actorUserId).toBe(a.adminUserId)
  })

  /**
   * O emissor deste evento mudou de casa na fatia 11.
   *
   * Era a porta interna do processo, que verificava o HMAC de serviço a serviço — e ela
   * sumiu com a consolidação, porque não há mais serviço a chamar. O tipo voltou para onde
   * o nome dele sempre apontou: a assinatura Svix do webhook do Resend, que é a única
   * superfície de backend que a borda publica (`infra/Caddyfile`) e a única em que uma
   * assinatura de fora é conferida.
   */
  it('AC-02: assinatura inválida no webhook vira WEBHOOK_SIGNATURE_INVALID', async () => {
    const { getApp } = await import('./fixtures.js')
    const app = await getApp()

    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/email/webhook',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_forjado',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,YXNzaW5hdHVyYS1pbnZhbGlkYQ==',
      },
      payload: { type: 'email.delivered', data: {} },
    })

    expect(response.statusCode).toBe(401)

    const evento = await ownerPrisma.securityEvent.findFirst({
      where: { type: 'WEBHOOK_SIGNATURE_INVALID' },
    })
    // Sem tenant a atribuir: a assinatura era justamente o que diria de quem se trata.
    expect(evento).toBeTruthy()
    expect(evento?.tenantId).toBeNull()
    expect(evento?.targetId).toBe('msg_forjado')
  })
})
