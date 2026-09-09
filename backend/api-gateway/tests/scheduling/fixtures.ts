import { randomUUID } from 'node:crypto'
import { asRole, ownerPrisma, resetDatabase as resetCore, type Caller } from '../harness.js'

/**
 * Cenário do MOD-AGENDA — o catálogo da agenda e os agendamentos.
 *
 * O núcleo (`../harness.js`) guarda o que é do processo: app, banco, token e os
 * chamadores por papel. O que fica aqui é o cenário deste módulo — tenant com fuso,
 * pet com porte e pelagem, serviço com preço, profissional com jornada.
 *
 * **As duas portas voltam ao real a cada teste.** A da agenda (`AppointmentsPort`) e a
 * do financeiro (`BillingPort`) são dubladas por vários casos para exercitar um AC
 * específico, e um dublê que sobrevive ao teste seguinte é a pior forma de
 * intermitência: ele passa sozinho e falha em suíte.
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

/**
 * Reseta o banco **e as duas portas**.
 *
 * Sobrescreve o `resetDatabase` do núcleo de propósito, e o `export *` acima já ficou
 * para trás nesta linha: os testes deste módulo chamam este, e os dos outros módulos
 * continuam com o do núcleo, que não conhece porta nenhuma da agenda.
 */
export async function resetDatabase(): Promise<void> {
  await resetCore()
  const [{ setAppointmentsPort }, { livePort }, { resetBillingPort }] = await Promise.all([
    import('../../src/modules/schedule-catalog/port.js'),
    import('../../src/modules/scheduling/port-impl.js'),
    import('../../src/modules/scheduling/gates.js'),
  ])
  setAppointmentsPort(livePort)
  resetBillingPort()
}

/**
 * Tenant, usuário administrador, DEK e `tenant_settings`.
 *
 * O fuso é **UTC de propósito** — assim os minutos das janelas dos fixtures (0–1440,
 * 480–1080) e os instantes UTC das asserções falam a mesma língua, e um teste que marca
 * 09:00 não passa a depender do horário de verão de São Paulo.
 */
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

  // Todo tenant real sai do onboarding com `tenant_settings`, e a agenda depende dele:
  // a jornada do profissional é hora de parede no fuso do tenant.
  await ownerPrisma.tenantSettings.create({
    data: { tenantId, branding: {}, businessHours: {}, timezone: 'UTC' },
  })

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

/** O administrador do tenant — o chamador mais comum destes testes. */
export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/**
 * A recepção, com as permissões **da matriz** e não de uma lista filtrada à mão.
 *
 * Enquanto isto era serviço, o harness assinava o contexto com `PERMISSION_KEYS` menos
 * `schedule:manage_catalog` — o que fazia a asserção de negação provar apenas que o
 * guarda lê a lista que recebeu. A matriz do MOD-IDENT-04 concede à recepção exatamente
 * o que estes testes montavam: `schedule:read_all` e `schedule:write_all` sim,
 * `schedule:manage_catalog` não. Agora é ela que responde.
 *
 * É `async` por isso: o papel vira um membership de verdade no banco.
 */
export async function asReceptionist(fixture: TenantFixture): Promise<Caller> {
  return asRole(fixture, 'RECEPTIONIST')
}

/** Horário de funcionamento do tenant, para o AC-03 da jornada. */
export async function givenBusinessHours(
  fixture: TenantFixture,
  hours: Record<string, { open: string; close: string }>,
): Promise<void> {
  await ownerPrisma.tenantSettings.update({
    where: { tenantId: fixture.tenantId },
    data: { businessHours: hours },
  })
}

/**
 * Ajusta `tenant_settings` do fixture. O registro já existe desde `givenTenant`, e cada
 * teste sobrescreve só o que o seu cenário precisa.
 */
export async function givenTenantSettings(
  fixture: TenantFixture,
  settings: Record<string, unknown>,
): Promise<void> {
  await ownerPrisma.tenantSettings.update({
    where: { tenantId: fixture.tenantId },
    data: settings,
  })
}

/** Os portes são catálogo global (MOD-PET-03); a agenda só os referencia. */
export async function sizeIds(): Promise<Record<'SMALL' | 'MEDIUM' | 'LARGE' | 'GIANT', string>> {
  const sizes = await ownerPrisma.size.findMany({ where: { tenantId: null } })
  const byKey = Object.fromEntries(sizes.map((size) => [size.key, size.id]))
  return {
    SMALL: byKey.SMALL ?? '',
    MEDIUM: byKey.MEDIUM ?? '',
    LARGE: byKey.LARGE ?? '',
    GIANT: byKey.GIANT ?? '',
  }
}

/**
 * Pet com responsável principal, criado direto no banco.
 *
 * A agenda lê pets e tutores mas não os cria — quem cadastra é o MOD-PET, e criá-los
 * pela API daqui acoplaria as duas suítes. O que importa para a agenda é a linha existir
 * no tenant certo, com porte e pelagem, que são o que decide a duração.
 */
export async function givenPet(
  fixture: TenantFixture,
  options: { name?: string; sizeKey?: string; coatKey?: string | null; status?: string } = {},
): Promise<{ petId: string; tutorId: string }> {
  const [species, size, coat] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({
      where: { key: options.sizeKey ?? 'LARGE', tenantId: null },
    }),
    options.coatKey === null
      ? Promise.resolve(null)
      : ownerPrisma.coat.findFirstOrThrow({
          where: { key: options.coatKey ?? 'SHORT', tenantId: null },
        }),
  ])

  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        personType: 'PF',
        fullName: `Tutor de ${options.name ?? 'Thor'}`,
        // A agenda não lê telefone; o que importa é a linha existir com o hash único
        // que o índice de busca exige.
        phoneEncrypted: 'v1:teste',
        phoneHash: randomUUID(),
        status: 'ACTIVE',
      },
    })

    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Thor',
        speciesId: species.id,
        sizeId: size.id,
        ...(coat ? { coatId: coat.id } : {}),
        status: (options.status ?? 'ACTIVE') as 'ACTIVE',
      },
    })

    await tx.petTutor.create({
      data: {
        tenantId: fixture.tenantId,
        petId: pet.id,
        tutorId: tutor.id,
        role: 'PRIMARY',
      },
    })

    return { petId: pet.id, tutorId: tutor.id }
  })
}

/** Serviço com preço e duração em todos os portes. */
export async function givenService(
  fixture: TenantFixture,
  options: { name?: string; category?: string; durationMin?: number; priceCents?: number } = {},
): Promise<string> {
  const sizes = await ownerPrisma.size.findMany({ where: { tenantId: null } })

  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Banho',
        category: (options.category ?? 'BATH') as 'BATH',
        baseDurationMin: options.durationMin ?? 60,
        pricing: {
          create: sizes.map((size) => ({
            tenantId: fixture.tenantId,
            sizeId: size.id,
            priceCents: BigInt(options.priceCents ?? 7000),
            durationMin: options.durationMin ?? 60,
          })),
        },
      },
    })
    return service.id
  })
}

/**
 * Profissional habilitado nos serviços, com jornada.
 *
 * A jornada padrão cobre a semana inteira das 08:00 às 18:00 **em UTC**: os testes
 * raciocinam em instantes, e misturar fuso aqui só esconderia o que está sendo
 * verificado.
 */
export async function givenProfessional(
  fixture: TenantFixture,
  options: {
    name?: string
    serviceIds?: string[]
    maxConcurrentPets?: number
    windows?: { weekday: number; startsAtMin: number; endsAtMin: number }[]
    /** `DRIVER` é o caso que a agenda precisa **não** enxergar (RN-03 do MOD-TAXI). */
    roleKey?: 'BATHER' | 'GROOMER' | 'VET' | 'DRIVER'
  } = {},
): Promise<string> {
  const windows =
    options.windows ??
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startsAtMin: 480, endsAtMin: 1080 }))

  return withTenant(fixture.tenantId, async (tx) => {
    const professional = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: options.name ?? 'Ana',
        roleKey: options.roleKey ?? 'BATHER',
        maxConcurrentPets: options.maxConcurrentPets ?? 1,
        schedules: {
          create: windows.map((window) => ({ tenantId: fixture.tenantId, ...window })),
        },
        services: {
          create: (options.serviceIds ?? []).map((serviceId) => ({
            tenantId: fixture.tenantId,
            serviceId,
          })),
        },
      },
    })
    return professional.id
  })
}
