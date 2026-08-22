import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  disconnectHelpers,
  ownerPrisma,
  rawAppPrisma,
  seedMembership,
  seedTenant,
  seedUser,
  truncateAll,
  type SeededTenant,
} from './helpers.js'

const {
  disconnectPrisma,
  getMaintenancePrisma,
  getPrisma,
  withTenant,
  TenantContextMissingError,
} = await import('../src/index.js')

/**
 * MOD-IDENT-07 — Isolamento RLS.
 *
 * SPEC §7.6 torna estes testes obrigatórios: "tentativa de acesso a dado de outro
 * tenant deve sempre falhar".
 */

let tenantA: SeededTenant
let tenantB: SeededTenant

beforeEach(async () => {
  await truncateAll()
  tenantA = await seedTenant('a')
  tenantB = await seedTenant('b')
})

afterAll(async () => {
  await Promise.all([disconnectHelpers(), disconnectPrisma()])
})

describe('AC-01 — o contexto de tenant é aplicado a toda transação', () => {
  it('enxerga apenas o próprio tenant', async () => {
    const visible = await withTenant(tenantA.id, (tx) =>
      tx.tenant.findMany({ select: { id: true, slug: true } }),
    )
    expect(visible).toHaveLength(1)
    expect(visible[0]?.id).toBe(tenantA.id)
  })

  it('enxerga apenas os memberships do próprio tenant', async () => {
    const user = await seedUser('dono@petshop.test')
    await seedMembership(tenantA.id, user.id)
    await seedMembership(tenantB.id, user.id)

    const fromA = await withTenant(tenantA.id, (tx) => tx.membership.findMany())
    expect(fromA).toHaveLength(1)
    expect(fromA[0]?.tenantId).toBe(tenantA.id)
  })

  it('mantém o contexto local à transação, sem vazar para a próxima', async () => {
    await withTenant(tenantA.id, (tx) => tx.tenant.findMany())

    // Mesma conexão do pool, transação nova e sem contexto: a política nega.
    const semContexto = await rawAppPrisma.tenant.findMany()
    expect(semContexto).toHaveLength(0)
  })
})

describe('AC-02 — acesso cross-tenant', () => {
  it('não encontra recurso de outro tenant pelo UUID (vira 404, nunca 403)', async () => {
    const found = await withTenant(tenantA.id, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantB.id } }),
    )
    // Ausência, não negação: a API traduz isso em ERR_IDENT_001, sem revelar
    // que o recurso existe em outro lugar.
    expect(found).toBeNull()
  })

  it('não encontra membership de outro tenant pelo UUID', async () => {
    const user = await seedUser('outro@petshop.test')
    const membershipB = await seedMembership(tenantB.id, user.id)

    const found = await withTenant(tenantA.id, (tx) =>
      tx.membership.findUnique({ where: { id: membershipB.id } }),
    )
    expect(found).toBeNull()
  })

  it('recusa escrita marcada com o tenant_id de outro tenant', async () => {
    const user = await seedUser('intruso@petshop.test')

    await expect(
      withTenant(tenantA.id, (tx) =>
        tx.membership.create({
          data: { tenantId: tenantB.id, userId: user.id, roleKey: 'TENANT_ADMIN' },
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('não altera linha de outro tenant nem mesmo por update em massa', async () => {
    const result = await withTenant(tenantA.id, (tx) =>
      tx.tenant.updateMany({ where: { id: tenantB.id }, data: { name: 'Invadido' } }),
    )
    expect(result.count).toBe(0)

    const untouched = await ownerPrisma.tenant.findUnique({ where: { id: tenantB.id } })
    expect(untouched?.name).toBe(tenantB.name)
  })

  it('não apaga linha de outro tenant', async () => {
    const result = await withTenant(tenantA.id, (tx) =>
      tx.tenant.deleteMany({ where: { id: tenantB.id } }),
    )
    expect(result.count).toBe(0)
    expect(await ownerPrisma.tenant.count()).toBe(2)
  })
})

describe('AC-03 — contexto ausente', () => {
  it('devolve vazio no banco quando app.tenant_id não foi setado', async () => {
    // Comportamento literal do AC: a política nega por padrão e o retorno é vazio.
    await expect(rawAppPrisma.tenant.findMany()).resolves.toEqual([])
    await expect(rawAppPrisma.membership.findMany()).resolves.toEqual([])
    await expect(rawAppPrisma.auditLog.findMany()).resolves.toEqual([])
  })

  it('a guarda de aplicação falha alto em vez de devolver vazio silencioso', async () => {
    await expect(getPrisma().tenant.findMany()).rejects.toThrow(TenantContextMissingError)
    await expect(getPrisma().membership.findMany()).rejects.toThrow(/contexto de tenant/i)
  })

  it('deixa passar tabelas globais, que não têm RLS', async () => {
    // roles, permissions e users são globais (RN-01, RN-05).
    await expect(getPrisma().role.count()).resolves.toBe(8)
    await expect(getPrisma().permission.count()).resolves.toBeGreaterThan(0)
    await expect(getPrisma().user.count()).resolves.toBeGreaterThanOrEqual(0)
  })

  it('a role app_maintenance enxerga todos os tenants (BYPASSRLS)', async () => {
    const all = await getMaintenancePrisma().tenant.findMany({ select: { id: true } })
    expect(all.map((t) => t.id).sort()).toEqual([tenantA.id, tenantB.id].sort())
  })
})

describe('trilha de auditoria append-only (PRD §9)', () => {
  it('aceita insert', async () => {
    const created = await withTenant(tenantA.id, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId: tenantA.id,
          action: 'tenant.created',
          entity: 'tenant',
          entityId: tenantA.id,
        },
      }),
    )
    expect(created.id).toBeTruthy()
  })

  // Camada 1 — o REVOKE. As roles da aplicação sequer chegam ao trigger.
  it('nega UPDATE e DELETE às roles da aplicação por falta de privilégio', async () => {
    const created = await withTenant(tenantA.id, (tx) =>
      tx.auditLog.create({
        data: { tenantId: tenantA.id, action: 'a', entity: 'tenant', entityId: tenantA.id },
      }),
    )

    await expect(
      withTenant(tenantA.id, (tx) =>
        tx.auditLog.update({ where: { id: created.id }, data: { action: 'forjado' } }),
      ),
    ).rejects.toThrow(/permission denied for table audit_logs/i)

    await expect(
      withTenant(tenantA.id, (tx) => tx.auditLog.delete({ where: { id: created.id } })),
    ).rejects.toThrow(/permission denied for table audit_logs/i)

    await expect(
      getMaintenancePrisma().auditLog.updateMany({ data: { action: 'forjado' } }),
    ).rejects.toThrow(/permission denied for table audit_logs/i)
  })

  // Camada 2 — o trigger. Vale para quem tem privilégio, inclusive o dono da tabela.
  it('nega UPDATE e DELETE até para o dono da tabela, via trigger', async () => {
    const created = await ownerPrisma.auditLog.create({
      data: { tenantId: tenantA.id, action: 'a', entity: 'tenant', entityId: tenantA.id },
    })

    await expect(
      ownerPrisma.auditLog.update({ where: { id: created.id }, data: { action: 'forjado' } }),
    ).rejects.toThrow(/append-only/i)

    await expect(
      ownerPrisma.auditLog.delete({ where: { id: created.id } }),
    ).rejects.toThrow(/append-only/i)

    // O registro original continua intacto.
    const still = await ownerPrisma.auditLog.findUnique({ where: { id: created.id } })
    expect(still?.action).toBe('a')
  })
})
