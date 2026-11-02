import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  authHeaders,
  closeHarness,
  getApp,
  givenTenant,
  installFakeEmailPort,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  type FakePort,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-NOTIF-12 — o convite de equipe pelo motor.
 *
 * O caminho inteiro, sem dublê do motor: o convite criado vira uma mensagem `USER` sem
 * `user_id`, sai pelo e-mail na mesma requisição e fica no painel de entregas.
 */

let fixture: TenantFixture
let email: FakePort

beforeAll(async () => {
  await getApp()
})

afterAll(closeHarness)

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  email = installFakeEmailPort()
  fixture = await givenTenant()
})

async function convidar(to = 'tosador@exemplo.com') {
  const app = await getApp()
  return app.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: authHeaders({ clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }),
    payload: { email: to, role: 'GROOMER' },
  })
}

describe('MOD-NOTIF-12 — o convite de equipe', () => {
  it('sai pelo motor, ao endereço digitado, com o link do convite', async () => {
    const response = await convidar()
    expect(response.statusCode).toBe(201)
    const { inviteUrl, id } = response.json()

    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]?.to).toBe('tosador@exemplo.com')
    expect(email.sent[0]?.subject).toContain('convidou você para a equipe')
    expect(email.sent[0]?.body).toContain(inviteUrl)

    const linha = await ownerPrisma.message.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, templateKey: 'team_invitation' },
    })
    expect(linha.recipientKind).toBe('USER')
    expect(linha.userId).toBeNull()
    expect(linha.originType).toBe('INVITATION')
    expect(linha.originId).toBe(id)
    expect(linha.status).toBe('SENT')
  })

  it('o convite revogado antes do despacho não sai', async () => {
    email.failNext()
    const response = await convidar()
    const { id } = response.json()
    expect(email.sent).toHaveLength(0)

    await ownerPrisma.invitation.update({ where: { id }, data: { status: 'REVOKED' } })
    // A falha reagenda a retentativa; traz para agora, que é quando o despacho olha.
    await ownerPrisma.message.updateMany({
      where: { tenantId: fixture.tenantId, templateKey: 'team_invitation' },
      data: { scheduledFor: new Date(Date.now() - 1000) },
    })
    const { dispatchTenant } = await import('../../src/modules/messaging/dispatch.js')
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect(email.sent).toHaveLength(0)
    const linha = await ownerPrisma.message.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, templateKey: 'team_invitation' },
    })
    expect(linha.status).toBe('BLOCKED')
  })

  it('a equipe que já tem conta não recebe em endereço avulso', async () => {
    const { enqueueMessage } = await import('../../src/modules/messaging/messages.js')
    const { EnqueueMessageSchema } = await import('@petshop/shared-types')
    await expect(
      enqueueMessage(
        { tenantId: fixture.tenantId },
        EnqueueMessageSchema.parse({
          recipientKind: 'USER',
          userId: fixture.userId,
          overrideAddress: 'outro@exemplo.com',
          channel: 'EMAIL',
          templateKey: 'team_invitation',
          dedupeKey: 'x',
          originType: 'INVITATION',
        }),
      ),
    ).rejects.toThrow()
  })
})
