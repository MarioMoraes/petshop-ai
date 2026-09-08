import { randomUUID } from 'node:crypto'
import { todayIn, zonedMidnight, type RoleKey } from '@petshop/shared-types'
import { asRole, ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-TAXI.
 *
 * Sobe o app de verdade — hooks, handler de erro, RLS, índices, banco — e não
 * substitui nada. É o índice único parcial `idx_taxi_rides_leg_alive` que prova o
 * AC-04, e a transação SERIALIZABLE de verdade que prova o RN-09.
 *
 * As fixtures ficam por módulo, e não num harness só, porque os nomes colidem: cada
 * módulo tem o seu `givenTenant`, com as configurações que **ele** precisa que
 * existam. O núcleo compartilhado (`../harness.js`) guarda o que é do processo — o
 * app, o banco, o token e os chamadores por papel — e é reexportado aqui para que o
 * teste importe de um lugar só.
 */

export * from '../harness.js'

const { createTenantKey, encryptForTenant, withTenant } = await import('@petshop/db')

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
      onboardingStep: 5,
      onboardingCompletedAt: new Date(),
      settings: {
        create: {
          timezone: 'America/Sao_Paulo',
          branding: {},
          businessHours: {},
        },
      },
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
    data: { tenantId, userId: user.id, roleKey: 'TENANT_ADMIN', status: 'ACTIVE' },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

export async function givenTutor(
  fixture: TenantFixture,
  options: { withAddress?: boolean; zipCode?: string } = {},
): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: 'Ana Souza',
        // Cifra de verdade, não `v1:x:x:x`: a rota do motorista **decifra** o
        // telefone, e um placeholder faria o teste passar por engano ao exercitar o
        // caminho de erro em vez do caminho normal.
        phoneEncrypted: await encryptForTenant(tx, fixture.tenantId, '+5511987654321'),
        phoneHash: `phone-${suffix}`,
      },
    })

    if (options.withAddress !== false) {
      // Cifrado com a **mesma** DEK do tenant: é o que permite a corrida copiar o
      // texto cifrado sem decifrar e recifrar (RN-11).
      const enc = (value: string) => encryptForTenant(tx, fixture.tenantId, value)
      await tx.tutorAddress.create({
        data: {
          tenantId: fixture.tenantId,
          tutorId: tutor.id,
          label: 'Casa',
          zipCode: options.zipCode ?? '04567000',
          streetEncrypted: await enc('Rua das Acácias'),
          numberEncrypted: await enc('120'),
          complementEncrypted: await enc('apto 31'),
          accessNotes: await enc('Portão azul, interfone 12'),
          district: 'Moema',
          city: 'São Paulo',
          state: 'SP',
          isPrimary: true,
        },
      })
    }

    return tutor.id
  })
}

export async function givenPet(fixture: TenantFixture, tutorId: string): Promise<string> {
  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
  ])

  return withTenant(fixture.tenantId, async (tx) => {
    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: 'Thor',
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

/**
 * Motorista com jornada. `weekday` cobre a semana inteira de propósito: os testes
 * marcam corridas em datas relativas a "agora", e restringir os dias faria a suíte
 * passar ou falhar conforme o dia em que roda.
 */
export async function givenDriver(
  fixture: TenantFixture,
  options: {
    name?: string
    capacity?: number
    userId?: string
    /** Sem jornada nenhuma: é assim que se prova o `OUT_OF_SCHEDULE`. */
    noSchedule?: boolean
  } = {},
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const driver = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: options.name ?? 'João Motorista',
        roleKey: 'DRIVER',
        maxConcurrentPets: options.capacity ?? 4,
        ...(options.userId ? { userId: options.userId } : {}),
      },
    })

    if (!options.noSchedule) {
      await tx.professionalSchedule.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          tenantId: fixture.tenantId,
          professionalId: driver.id,
          weekday,
          // 00:00–23:59 no fuso do tenant: a jornada não é o que está sob teste,
          // exceto no caso que a remove de propósito.
          startsAtMin: 0,
          endsAtMin: 1439,
        })),
      })
    }

    return driver.id
  })
}

export async function givenVehicle(
  fixture: TenantFixture,
  options: { capacity?: number; plate?: string } = {},
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const vehicle = await tx.taxiVehicle.create({
      data: {
        tenantId: fixture.tenantId,
        plate: options.plate ?? 'ABC1D23',
        label: 'Van branca',
        petCapacity: options.capacity ?? 4,
      },
    })
    return vehicle.id
  })
}

/** O serviço de catálogo, categoria TAXI, que ancora a cobrança (RN-05). */
export async function givenTaxiService(fixture: TenantFixture): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: 'Taxi Dog',
        category: 'TAXI',
        baseDurationMin: 0,
      },
    })
    return service.id
  })
}

/**
 * O dia civil de hoje no fuso do tenant, e um horário dentro dele.
 *
 * As janelas dos testes de painel e de rota **não** podem ser calculadas a partir de
 * "agora + N horas": rodando a suíte à noite, a janela atravessaria a meia-noite
 * local, e aí ela deixa de caber em uma faixa de jornada — o `checkDriverWindow`
 * recusaria, corretamente, e o teste falharia por um motivo que não é o que ele
 * pretende provar.
 */
export const TEST_TIMEZONE = 'America/Sao_Paulo'

export function localToday(): string {
  return todayIn(TEST_TIMEZONE)
}

export function localDayToday(hour: number): Date {
  return new Date(zonedMidnight(localToday(), TEST_TIMEZONE).getTime() + hour * 3_600_000)
}

export interface AppointmentFixture {
  appointmentId: string
  petId: string
  tutorId: string
  professionalId: string
  startsAt: Date
  endsAt: Date
}

/**
 * Um agendamento futuro com um item de banho. Futuro porque a corrida de ida precisa
 * caber **antes** do início do atendimento (AC-03), e um agendamento no passado
 * tornaria toda janela de coleta inválida.
 */
export async function givenAppointment(
  fixture: TenantFixture,
  options: {
    tutorId?: string
    status?: 'CONFIRMED' | 'COMPLETED'
    hoursFromNow?: number
    /** Vence `hoursFromNow`. Use com `localDayToday()` para ficar dentro do dia civil. */
    startsAt?: Date
  } = {},
): Promise<AppointmentFixture> {
  const tutorId = options.tutorId ?? (await givenTutor(fixture))
  const petId = await givenPet(fixture, tutorId)

  const professionalId = await withTenant(fixture.tenantId, async (tx) => {
    const groomer = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: `Bruna Tosadora ${randomUUID().slice(0, 8)}`,
        roleKey: 'GROOMER',
      },
    })
    return groomer.id
  })

  // Nome único por chamada: `services` tem unicidade por tenant, e um teste que cria
  // dois agendamentos no mesmo tenant colidiria no segundo "Banho".
  const serviceId = await withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: `Banho ${randomUUID().slice(0, 8)}`,
        category: 'BATH',
        baseDurationMin: 60,
      },
    })
    return service.id
  })

  const startsAt =
    options.startsAt ?? new Date(Date.now() + (options.hoursFromNow ?? 24) * 3_600_000)
  const endsAt = new Date(startsAt.getTime() + 3_600_000)

  const appointmentId = await withTenant(fixture.tenantId, async (tx) => {
    const appointment = await tx.appointment.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        professionalId,
        startsAt,
        endsAt,
        status: options.status ?? 'CONFIRMED',
        totalCents: BigInt(8000),
        items: {
          create: [
            {
              tenantId: fixture.tenantId,
              serviceId,
              label: 'Banho',
              priceCents: BigInt(8000),
              durationMin: 60,
            },
          ],
        },
      },
      select: { id: true },
    })
    return appointment.id
  })

  return { appointmentId, petId, tutorId, professionalId, startsAt, endsAt }
}

/** Um usuário a mais no tenant, para o motorista ter login próprio. */
export async function givenUser(fixture: TenantFixture, roleKey: RoleKey): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Motorista de Teste',
    },
  })
  await ownerPrisma.membership.create({
    data: { tenantId: fixture.tenantId, userId: user.id, roleKey, status: 'ACTIVE' },
  })
  return user.id
}

/** Liga o módulo e aponta o serviço de cobrança — o pré-requisito de tudo (RN-22). */
export async function enableTaxi(
  fixture: TenantFixture,
  options: { defaultPriceCents?: number; blockOutsideZones?: boolean } = {},
): Promise<string> {
  const serviceId = await givenTaxiService(fixture)
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.taxiSettings.create({
      data: {
        tenantId: fixture.tenantId,
        enabled: true,
        taxiServiceId: serviceId,
        defaultPriceCents: BigInt(options.defaultPriceCents ?? 2000),
        blockOutsideZones: options.blockOutsideZones ?? false,
      },
    })
  })
  return serviceId
}

// ─── Chamadores ──────────────────────────────────────────────────────────────

/**
 * Quem chama, resolvido como em produção.
 *
 * As permissões saem da matriz de papéis pelo `membership`, e não de uma lista escrita
 * no teste: enquanto o Taxi Dog era um serviço, o harness assinava um contexto com as
 * permissões que quisesse. Agora a identidade entra pela mesma porta do Admin — token,
 * membership e matriz — e o teste passou a provar também que o papel concede o que o
 * §9 diz que concede.
 */
export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/** Recepção: opera tudo, mas não configura zona, frota nem preço (§9). */
export async function asReceptionist(fixture: TenantFixture): Promise<Caller> {
  return asRole(fixture, 'RECEPTIONIST')
}

/**
 * Motorista: opera só as **próprias** corridas (RN-19).
 *
 * Recebe o usuário que já foi criado por `givenUser` e vinculado ao `professional`,
 * porque é o vínculo `professional.userId` que o módulo usa para saber de quem é a
 * corrida. Criar um membro novo aqui daria um motorista sem ficha.
 */
export async function asDriver(fixture: TenantFixture, driverUserId: string): Promise<Caller> {
  const user = await ownerPrisma.user.findUniqueOrThrow({ where: { id: driverUserId } })
  return { clerkUserId: user.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}
