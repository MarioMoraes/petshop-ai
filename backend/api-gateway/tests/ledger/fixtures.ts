import { randomUUID } from 'node:crypto'
import { asRole, ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-LEDGER — a conta corrente do tutor.
 *
 * O núcleo (`../harness.js`) guarda o que é do processo: app, banco, token e os
 * chamadores por papel. O que fica aqui é o cenário deste módulo — tutor, pet, serviço e
 * pacote —, mais os dois leitores de banco que as asserções usam: o saldo materializado
 * e a lista de lançamentos na ordem em que nasceram.
 *
 * A suíte exercita o app inteiro, e aqui isso vale mais que na média: o
 * `chk_credits_bounds`, o trigger de imutabilidade e o índice único de idempotência são
 * metade das garantias deste módulo, e testá-los contra um dublê provaria nada.
 */

export * from '../harness.js'

const { createTenantKey, withTenant } = await import('@petshop/db')

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
  /** O gateway resolve o tenant pela Organization do token — daí o campo. */
  clerkOrgId: string
}

export async function givenTenant(name = 'Petshop Teste'): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const clerkOrgId = `org_${suffix}`

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug: `teste-${suffix}`,
      name,
      clerkOrgId,
      status: 'ACTIVE',
      plan: 'PRO',
      provisioningKey: `prov-${suffix}`,
      onboardingStep: 4,
      onboardingCompletedAt: new Date(),
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Atendente de Teste',
    },
  })

  await ownerPrisma.membership.create({
    data: {
      tenantId,
      userId: user.id,
      roleKey: 'TENANT_ADMIN',
      status: 'ACTIVE',
      // MOD-SEC-03: o mesmo prazo que o produto concede a quem vira administrador.
      mfaGraceUntil: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

/** O administrador do tenant — o chamador mais comum destes testes. */
export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/**
 * A recepção, com as permissões **da matriz**.
 *
 * O harness antigo já derivava esta lista de `ROLE_PERMISSIONS` em vez de filtrá-la à
 * mão, e a razão dada continua sendo a certa: metade dos cortes do §9 é exatamente o que
 * separa recepção de gestor no financeiro — `finance:refund`, `finance:credit`,
 * `finance:configure`. O que muda agora é que o papel vira um `membership` de verdade e
 * a permissão entra pela porta da produção, e não por um contexto assinado à mão.
 */
export async function asReceptionist(fixture: TenantFixture): Promise<Caller> {
  return asRole(fixture, 'RECEPTIONIST')
}

/**
 * Tutor no banco.
 *
 * O financeiro lê tutores mas não os cria — quem cadastra é o MOD-TUTOR, e criá-lo pela
 * API daqui acoplaria as duas suítes. O que importa aqui é a linha existir no tenant
 * certo, porque `openAccount` recusa tutor inexistente.
 */
export async function givenTutor(fixture: TenantFixture, fullName = 'Maria Silva'): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
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
  })
}

/** Pet vinculado a um tutor — necessário para pacote com `petId`. */
export async function givenPet(
  fixture: TenantFixture,
  tutorId: string,
  name = 'Thor',
): Promise<string> {
  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
  ])

  return withTenant(fixture.tenantId, async (tx) => {
    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        speciesId: species.id,
        sizeId: size.id,
        status: 'ACTIVE',
      },
    })
    await tx.petTutor.create({
      data: { tenantId: fixture.tenantId, petId: pet.id, tutorId, role: 'PRIMARY' },
    })
    return pet.id
  })
}

/** Serviço do catálogo da agenda — o pacote casa por `service_id` (RN-10). */
export async function givenService(fixture: TenantFixture, name = 'Banho'): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        category: 'BATH',
        baseDurationMin: 60,
      },
    })
    return service.id
  })
}

/** Pacote no catálogo do tenant. */
export async function givenPackage(
  fixture: TenantFixture,
  options: {
    name?: string
    serviceIds: string[]
    credits?: number
    priceCents?: number
    validityDays?: number
  },
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const pkg = await tx.servicePackage.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? '4 Banhos Porte Médio',
        serviceIds: options.serviceIds,
        credits: options.credits ?? 4,
        priceCents: BigInt(options.priceCents ?? 32000),
        validityDays: options.validityDays ?? 90,
      },
    })
    return pkg.id
  })
}

/** O saldo materializado, lido direto do banco — é o número que a suíte confere. */
export async function balanceOf(fixture: TenantFixture, tutorId: string): Promise<number> {
  return withTenant(fixture.tenantId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId },
      select: { balanceCents: true },
    })
    return Number(account?.balanceCents ?? 0)
  })
}

/**
 * Lançamentos da conta, do mais antigo ao mais novo — a ordem em que nasceram.
 *
 * O retorno é declarado, e não inferido do Prisma: sem a anotação o `tsc` do `build`
 * recusa emitir (TS2742, "cannot be named without a reference to node_modules"). O
 * `typecheck` passa mesmo assim, porque não emite — então este erro só aparece no
 * build, e é onde ele foi pego.
 */
export interface EntryRow {
  id: string
  direction: 'DEBIT' | 'CREDIT'
  amountCents: bigint
  signedAmountCents: bigint | null
  balanceAfterCents: bigint
  settledCents: bigint
  category: string
  description: string
  sourceType: string
  sourceId: string | null
  status: string
  reversedByEntryId: string | null
  reversesEntryId: string | null
}

export async function entriesOf(fixture: TenantFixture, tutorId: string): Promise<EntryRow[]> {
  return withTenant(fixture.tenantId, (tx) =>
    tx.ledgerEntry.findMany({
      where: { tutorId },
      select: {
        id: true,
        direction: true,
        amountCents: true,
        signedAmountCents: true,
        balanceAfterCents: true,
        settledCents: true,
        category: true,
        description: true,
        sourceType: true,
        sourceId: true,
        status: true,
        reversedByEntryId: true,
        reversesEntryId: true,
      },
      orderBy: [{ postedAt: 'asc' }, { createdAt: 'asc' }],
    }),
  )
}

export function actorOf(fixture: TenantFixture) {
  return { tenantId: fixture.tenantId, actorUserId: fixture.userId }
}
