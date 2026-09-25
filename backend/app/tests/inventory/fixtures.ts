import { randomUUID } from 'node:crypto'
import { ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-ESTOQUE.
 *
 * O estoque é recurso do Pro (`INVENTORY`), e o tenant nasce Pro por padrão — o teste
 * que exercita o bloqueio do Starter pede o plano explicitamente. O fuso entra de
 * verdade porque "vencido" e "vencendo" são contados a partir do dia **do
 * estabelecimento**.
 */

export * from '../harness.js'

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
  clerkOrgId: string
}

export async function givenTenant(
  plan: 'STARTER' | 'PRO' | 'ENTERPRISE' = 'PRO',
  timezone = 'America/Sao_Paulo',
): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const clerkOrgId = `org_${suffix}`

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug: `estoque-${suffix}`,
      name: 'Petshop Estoque',
      clerkOrgId,
      status: 'ACTIVE',
      plan,
      provisioningKey: `prov-${suffix}`,
      onboardingStep: 5,
      onboardingCompletedAt: new Date(),
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Gerente de Estoque',
    },
  })

  await ownerPrisma.membership.create({
    data: {
      tenantId,
      userId: user.id,
      roleKey: 'TENANT_ADMIN',
      status: 'ACTIVE',
      mfaGraceUntil: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  await ownerPrisma.tenantSettings.create({
    data: { tenantId, branding: {}, businessHours: {}, timezone },
  })

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/** A chave que a tela gera ao abrir o formulário. */
export function chave(): string {
  return `k-${randomUUID()}`
}

/** `AAAA-MM-DD` daqui a `dias` dias, em UTC — longe o bastante das bordas do fuso. */
export function emDias(dias: number): string {
  return new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10)
}

/** Um tutor mínimo, sem DEK: a venda só precisa de alguém a quem cobrar. */
export async function givenTutor(
  fixture: TenantFixture,
  fullName = 'Maria Silva',
): Promise<string> {
  const tutor = await ownerPrisma.tutor.create({
    data: {
      tenantId: fixture.tenantId,
      personType: 'PF',
      fullName,
      phoneEncrypted: 'v1:teste',
      phoneHash: randomUUID(),
      status: 'ACTIVE',
    },
  })
  return tutor.id
}

/** O limite de crédito do estabelecimento (MOD-LEDGER-09). */
export async function givenCreditLimit(fixture: TenantFixture, creditLimitCents: number) {
  await ownerPrisma.billingSettings.create({
    data: { tenantId: fixture.tenantId, creditLimitCents: BigInt(creditLimitCents) },
  })
}

/** O saldo da conta corrente do tutor, como o razão o guarda. Negativo é dívida. */
export async function balanceOf(tutorId: string): Promise<number> {
  const account = await ownerPrisma.ledgerAccount.findFirst({ where: { tutorId } })
  return Number(account?.balanceCents ?? 0)
}

export interface AttendanceFixture {
  attendanceId: string
  itemId: string
  petId: string
  tutorId: string
}

/**
 * Um atendimento concluído, dentro da janela de 24h, com um item.
 *
 * Direto no banco e não pelo check-out: o que estes testes exercitam é a edição e a
 * anulação, e a agenda inteira no caminho só trocaria o assunto. A DEK entra porque a
 * edição abre o cifrador para a observação.
 */
export async function givenAttendance(
  fixture: TenantFixture,
  performedAt: Date = new Date(Date.now() - 3_600_000),
): Promise<AttendanceFixture> {
  const { createTenantKey, withTenant } = await import('@petshop/db')
  if (!(await ownerPrisma.dataKey.findFirst({ where: { tenantId: fixture.tenantId } }))) {
    await withTenant(fixture.tenantId, (tx) => createTenantKey(tx, fixture.tenantId))
  }

  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
  ])
  const tutorId = await givenTutor(fixture, 'Ana Souza')
  const pet = await ownerPrisma.pet.create({
    data: {
      tenantId: fixture.tenantId,
      name: 'Thor',
      speciesId: species.id,
      sizeId: size.id,
      status: 'ACTIVE',
    },
  })
  const service = await ownerPrisma.service.create({
    data: {
      tenantId: fixture.tenantId,
      name: `Vacina ${randomUUID().slice(0, 6)}`,
      category: 'VACCINE',
      baseDurationMin: 30,
    },
  })

  const attendance = await ownerPrisma.attendance.create({
    data: {
      tenantId: fixture.tenantId,
      petId: pet.id,
      tutorId,
      type: 'VACCINE',
      origin: 'RETROACTIVE',
      performedBy: randomUUID(),
      startedAt: performedAt,
      finishedAt: performedAt,
      status: 'COMPLETED',
      editableUntil: new Date(performedAt.getTime() + 24 * 3_600_000),
      totalCents: BigInt(12_000),
      createdBy: fixture.userId,
      items: {
        create: {
          tenantId: fixture.tenantId,
          serviceId: service.id,
          label: 'Vacina',
          executedBy: randomUUID(),
          unitPriceCents: BigInt(12_000),
          totalPriceCents: BigInt(12_000),
        },
      },
    },
    include: { items: true },
  })

  return { attendanceId: attendance.id, itemId: attendance.items[0]!.id, petId: pet.id, tutorId }
}
