import { randomUUID } from 'node:crypto'
import { ownerPrisma, seedMember, seedTenant, type Caller, type SeededTenant } from '../harness.js'

/**
 * O cenário do MOD-SEC.
 *
 * O núcleo vem de `../harness.ts`. O que este módulo acrescenta é pouco e específico:
 * um administrador cujo estado de segundo fator o teste controla, e um jeito de semear
 * trilha antiga sem esperar dois anos.
 */

export * from '../harness.js'

export interface SecurityFixture extends SeededTenant {
  admin: Caller
  adminUserId: string
  adminMembershipId: string
}

/**
 * Um estabelecimento com um administrador que **já ligou** o segundo fator.
 *
 * É o padrão porque é o estado normal depois da Fase 7: quem exercita o gate pede
 * explicitamente o contrário, com `withoutMfa`.
 */
export async function givenSecurityTenant(slug: string): Promise<SecurityFixture> {
  const tenant = await seedTenant(slug)
  const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
  return {
    ...tenant,
    admin: { clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId },
    adminUserId: member.userId,
    adminMembershipId: member.membershipId,
  }
}

/**
 * O mesmo administrador, com o claim de MFA que o teste quiser.
 *
 * `null` é a terceira posição, e não um detalhe: é o JWT template do Clerk que ainda não
 * declara o claim (AC-02 de MOD-SEC-01), e o comportamento esperado ali é **passar**.
 */
export function withMfa(caller: Caller, mfaEnabled: boolean | null): Caller {
  return { ...caller, mfaEnabled }
}

/** Move a carência do administrador para o passado, sem esperar sete dias. */
export async function expireGrace(fixture: SecurityFixture): Promise<void> {
  await ownerPrisma.membership.update({
    where: { id: fixture.adminMembershipId },
    data: { mfaGraceUntil: new Date(Date.now() - 60_000) },
  })
}

/** Estende a carência para o futuro. */
export async function extendGrace(fixture: SecurityFixture, days = 7): Promise<void> {
  await ownerPrisma.membership.update({
    where: { id: fixture.adminMembershipId },
    data: { mfaGraceUntil: new Date(Date.now() + days * 24 * 60 * 60 * 1000) },
  })
}

/**
 * Uma linha de trilha com data escolhida.
 *
 * Escrita pelo cliente dono, e não pela aplicação: `audit_logs` é append-only e o
 * `recordAudit` sempre carimba `now()`. Um teste de retenção que não pudesse escrever no
 * passado teria de esperar dois anos.
 */
export async function seedAuditLog(input: {
  tenantId: string | null
  createdAt: Date
  action?: string
  actorUserId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await ownerPrisma.auditLog.create({
    data: {
      id,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      action: input.action ?? 'teste.acao',
      entity: 'teste',
      entityId: randomUUID(),
      createdAt: input.createdAt,
    },
  })
  return id
}

export async function seedSecurityEvent(input: {
  tenantId: string | null
  createdAt: Date
  type?: 'PERMISSION_DENIED' | 'CROSS_TENANT_ATTEMPT' | 'LOGIN_FAILED' | 'MFA_REQUIRED'
}): Promise<string> {
  const id = randomUUID()
  await ownerPrisma.securityEvent.create({
    data: {
      id,
      tenantId: input.tenantId,
      type: input.type ?? 'PERMISSION_DENIED',
      createdAt: input.createdAt,
    },
  })
  return id
}
