import { randomUUID } from 'node:crypto'
import { asRole, ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-PRONT — o prontuário de segurança, o atendimento e o receituário.
 *
 * O núcleo (`../harness.js`) guarda o que é do processo: app, banco, token e os
 * chamadores por papel. O que fica aqui é o cenário deste módulo, e ele é o mais caro
 * de todos — **o atendimento não nasce de um POST**, nasce do check-out da agenda, e
 * montá-lo exige o cenário inteiro do outro lado: tutor, pet vinculado, profissional,
 * serviço com preço e agendamento.
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
 * Tenant, usuário administrador e DEK.
 *
 * Sem a DEK nada cifrado pode ser gravado, e no prontuário quase tudo é: a reação da
 * alergia e a posologia da prescrição são dado clínico.
 *
 * **Não cria `tenant_settings` de propósito.** É o cenário de quem nunca preencheu o
 * endereço do estabelecimento, e o AC-02 de MOD-DOC-01 manda recusar a emissão de
 * documento formal dizendo qual dado falta. Quem quer o caso feliz chama
 * `givenIssuerSettings`.
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
      onboardingStep: 5,
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
 * Um membro do tenant com o papel pedido.
 *
 * **As permissões saem da matriz, e não de uma lista escrita no teste.** Enquanto isto
 * era serviço, o harness assinava o contexto com as permissões que o teste quisesse — o
 * que fazia toda asserção de negação provar apenas que o guarda lê a lista que recebeu.
 * A matriz do MOD-IDENT-04 concede a cada papel exatamente o que estes testes pediam à
 * mão, e agora é ela que responde: `record:read_alerts` é de todo mundo que encosta no
 * animal, inclusive o motorista, e `record:write` é só do administrador e do veterinário.
 */
export async function asRoleIn(fixture: TenantFixture, roleKey: string): Promise<Caller> {
  return asRole(fixture, roleKey)
}

/**
 * Pet criado direto no banco, com espécie e porte do catálogo global.
 *
 * O prontuário lê pets mas não os cria — quem cadastra é o MOD-PET. Criá-lo pela API
 * daqui acoplaria as duas suítes por um dado que, para este módulo, só precisa existir
 * no tenant certo.
 */
export async function givenPet(fixture: TenantFixture, name = 'Thor'): Promise<string> {
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
    return pet.id
  })
}

export async function givenTutor(fixture: TenantFixture, name = 'Ana Souza'): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: name,
        phoneEncrypted: 'v1:x:x:x',
        phoneHash: `phone-${suffix}`,
      },
    })
    return tutor.id
  })
}

export async function linkTutor(
  fixture: TenantFixture,
  petId: string,
  tutorId: string,
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.petTutor.create({
      data: { tenantId: fixture.tenantId, petId, tutorId, role: 'PRIMARY' },
    })
  })
}

export async function givenProfessional(
  fixture: TenantFixture,
  userId?: string,
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const professional = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: 'Bruna Tosadora',
        roleKey: 'GROOMER',
        ...(userId ? { userId } : {}),
      },
    })
    return professional.id
  })
}

/**
 * O veterinário que assina o receituário (MOD-DOC-04).
 *
 * O `userId` é o que amarra o profissional ao usuário autenticado: quem prescreve é
 * quem está logado, e não o `performed_by` do atendimento. Sem esse vínculo, o serviço
 * recusa com `ERR_PRONT_009` — que é justamente o comportamento sob teste.
 */
export async function givenVet(
  fixture: TenantFixture,
  options: { userId?: string; crmv?: string | null; crmvState?: string | null } = {},
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const vet = await tx.professional.create({
      data: {
        tenantId: fixture.tenantId,
        displayName: 'Dra. Helena Prado',
        roleKey: 'VET',
        userId: options.userId ?? fixture.userId,
        crmv: options.crmv === undefined ? '12345' : options.crmv,
        crmvState: options.crmvState === undefined ? 'SP' : options.crmvState,
      },
    })
    return vet.id
  })
}

/**
 * O cadastro do estabelecimento, sem o qual nenhum documento formal sai.
 *
 * Tenants criados antes de 2026-08-28 estão sem endereço, e o AC-02 de MOD-DOC-01 manda
 * recusar a emissão dizendo qual dado falta. O `givenTenant` não cria estas linhas de
 * propósito: é o cenário de quem nunca preencheu.
 */
export async function givenIssuerSettings(fixture: TenantFixture): Promise<void> {
  await ownerPrisma.tenantSettings.create({
    data: {
      tenantId: fixture.tenantId,
      branding: { primaryColor: '#2f6f5a' },
      businessHours: {},
      addressZip: '01310100',
      addressStreet: 'Avenida Paulista',
      addressNumber: '1000',
      addressDistrict: 'Bela Vista',
      addressCity: 'São Paulo',
      addressState: 'SP',
      publicPhone: '11 3000-0000',
    },
  })
}

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

export interface AppointmentFixture {
  appointmentId: string
  petId: string
  tutorId: string
  professionalId: string
  serviceId: string
}

export async function givenAppointment(
  fixture: TenantFixture,
  options: { status?: 'CHECKED_IN' | 'COMPLETED'; professionalUserId?: string } = {},
): Promise<AppointmentFixture> {
  const petId = await givenPet(fixture)
  const tutorId = await givenTutor(fixture)
  await linkTutor(fixture, petId, tutorId)
  const professionalId = await givenProfessional(fixture, options.professionalUserId)
  const serviceId = await givenService(fixture)

  const startsAt = new Date(Date.now() - 3_600_000)

  const appointmentId = await withTenant(fixture.tenantId, async (tx) => {
    const appointment = await tx.appointment.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        professionalId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        status: options.status ?? 'CHECKED_IN',
        totalCents: BigInt(8000),
        checkinAt: startsAt,
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

  return { appointmentId, petId, tutorId, professionalId, serviceId }
}

/** O payload que o check-out da agenda publica — a porta de entrada do módulo. */
export function checkoutEvent(
  fixture: TenantFixture,
  appointment: AppointmentFixture,
  overrides: Record<string, unknown> = {},
) {
  return {
    tenantId: fixture.tenantId,
    appointmentId: appointment.appointmentId,
    petId: appointment.petId,
    tutorId: appointment.tutorId,
    professionalId: appointment.professionalId,
    items: [{ serviceId: appointment.serviceId, label: 'Banho', priceCents: 8000 }],
    totalCents: 8000,
    weightKg: 12.5,
    origin: 'SCHEDULED',
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  }
}
