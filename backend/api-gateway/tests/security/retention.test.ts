import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closeHarness,
  givenSecurityTenant,
  ownerPrisma,
  resetDatabase,
  seedAuditLog,
  seedSecurityEvent,
} from './fixtures.js'

/** MOD-SEC-08 — a retenção de 24 meses, e a exceção nomeada ao append-only. */

beforeEach(resetDatabase)
afterAll(closeHarness)

const { runAuditRetentionOnce } = await import('../../src/modules/security/retention.js')

/** Vinte e cinco meses: fora da janela por folga, para o teste não depender do mês. */
const ANTIGO = new Date(Date.now() - 25 * 30 * 86_400_000)
const RECENTE = new Date(Date.now() - 86_400_000)

describe('MOD-SEC-08 — expurgo', () => {
  it('AC-01: apaga o que passou de 24 meses e preserva o resto', async () => {
    const fixture = await givenSecurityTenant('expurgo')
    const velho = await seedAuditLog({ tenantId: fixture.tenantId, createdAt: ANTIGO })
    const novo = await seedAuditLog({ tenantId: fixture.tenantId, createdAt: RECENTE })
    const eventoVelho = await seedSecurityEvent({ tenantId: fixture.tenantId, createdAt: ANTIGO })
    const eventoNovo = await seedSecurityEvent({ tenantId: fixture.tenantId, createdAt: RECENTE })

    const result = await runAuditRetentionOnce()

    expect(result.auditLogs).toBe(1)
    expect(result.securityEvents).toBe(1)
    expect(await ownerPrisma.auditLog.findUnique({ where: { id: velho } })).toBeNull()
    expect(await ownerPrisma.auditLog.findUnique({ where: { id: novo } })).toBeTruthy()
    expect(await ownerPrisma.securityEvent.findUnique({ where: { id: eventoVelho } })).toBeNull()
    expect(await ownerPrisma.securityEvent.findUnique({ where: { id: eventoNovo } })).toBeTruthy()
  })

  /**
   * A varredura é cross-tenant do começo ao fim, e é por isso que alcança as linhas de
   * plataforma. Amarrá-la a um `withTenant` deixaria justamente essas de fora, para
   * sempre — e elas são as dos incidentes mais graves.
   */
  it('alcança a linha de plataforma, que nenhum tenant enxerga', async () => {
    await seedAuditLog({ tenantId: null, createdAt: ANTIGO })
    await seedSecurityEvent({ tenantId: null, createdAt: ANTIGO })

    const result = await runAuditRetentionOnce()

    expect(result.auditLogs).toBe(1)
    expect(result.securityEvents).toBe(1)
    expect(await ownerPrisma.auditLog.count({ where: { tenantId: null } })).toBe(0)
  })

  it('AC-02: varre em lotes até esvaziar', async () => {
    const fixture = await givenSecurityTenant('lotes')
    for (let i = 0; i < 7; i += 1) {
      await seedAuditLog({
        tenantId: fixture.tenantId,
        createdAt: new Date(ANTIGO.getTime() - i * 60_000),
      })
    }

    // Lote de 2 força quatro passadas; o resultado é o total, não o do último lote.
    process.env.AUDIT_RETENTION_BATCH = '2'
    const { resetEnvCache } = await import('../../src/config/env.js')
    resetEnvCache()
    try {
      const result = await runAuditRetentionOnce()
      expect(result.auditLogs).toBe(7)
      expect(result.incomplete).toBe(false)
    } finally {
      delete process.env.AUDIT_RETENTION_BATCH
      resetEnvCache()
    }

    expect(await ownerPrisma.auditLog.count({ where: { tenantId: fixture.tenantId } })).toBe(0)
  })

  it('é idempotente: rodar de novo não apaga nada', async () => {
    const fixture = await givenSecurityTenant('idempotente')
    await seedAuditLog({ tenantId: fixture.tenantId, createdAt: ANTIGO })

    expect((await runAuditRetentionOnce()).auditLogs).toBe(1)
    expect((await runAuditRetentionOnce()).auditLogs).toBe(0)
  })
})

describe('MOD-SEC-08 — a trilha continua imutável', () => {
  /**
   * AC-03 e AC-04: o que se abriu foi a **saída**, e só para `app_maintenance`. Um
   * `UPDATE` continua barrado para todos, inclusive ela — é a diferença entre expurgo e
   * falsificação, e ela está no schema, não na disciplina de quem escreve o job.
   */
  it('AC-04: `app_user` não apaga linha nenhuma', async () => {
    const fixture = await givenSecurityTenant('imutavel')
    await seedAuditLog({ tenantId: fixture.tenantId, createdAt: ANTIGO })

    const { withTenant } = await import('@petshop/db')
    await expect(
      withTenant(fixture.tenantId, (tx) => tx.auditLog.deleteMany({})),
    ).rejects.toThrow()

    expect(await ownerPrisma.auditLog.count({ where: { tenantId: fixture.tenantId } })).toBe(1)
  })

  it('AC-05: nem `app_user` nem o expurgo conseguem alterar uma linha', async () => {
    const fixture = await givenSecurityTenant('semupdate')
    await seedAuditLog({ tenantId: fixture.tenantId, createdAt: RECENTE, action: 'original' })

    const { withTenant, getMaintenancePrisma } = await import('@petshop/db')

    await expect(
      withTenant(fixture.tenantId, (tx) =>
        tx.auditLog.updateMany({ data: { action: 'adulterado' } }),
      ),
    ).rejects.toThrow()

    await expect(
      getMaintenancePrisma().auditLog.updateMany({ data: { action: 'adulterado' } }),
    ).rejects.toThrow()

    const row = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { tenantId: fixture.tenantId },
    })
    expect(row.action).toBe('original')
  })
})
