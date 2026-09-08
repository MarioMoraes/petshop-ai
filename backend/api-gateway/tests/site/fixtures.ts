import { randomUUID } from 'node:crypto'
import { asRole, ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-SITE.
 *
 * As fixtures ficam por módulo, e não num harness só, porque os nomes colidem: cada
 * módulo tem o seu `givenTenant`, com as configurações que **ele** precisa que
 * existam. O núcleo compartilhado (`../harness.js`) guarda o que é do processo — o
 * app, o banco, o token e os chamadores por papel — e é reexportado aqui para que o
 * teste importe de um lugar só.
 */

export * from '../harness.js'

const { createTenantKey, withTenant } = await import('@petshop/db')

export interface TenantFixture {
  tenantId: string
  slug: string
  userId: string
  clerkUserId: string
  clerkOrgId: string
}

export interface TenantOptions {
  /** RN-06: o site acompanha o estado da conta. */
  status?: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED'
  /** AC-02 de MOD-SITE-01: sem endereço não se publica. */
  withAddress?: boolean
  withContact?: boolean
  onlineBookingEnabled?: boolean
}

export async function givenTenant(options: TenantOptions = {}): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const slug = `teste-${suffix}`
  const clerkOrgId = `org_${suffix}`
  const withAddress = options.withAddress ?? true
  const withContact = options.withContact ?? true

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug,
      name: 'Petshop do João',
      status: options.status ?? 'ACTIVE',
      plan: 'PRO',
      provisioningKey: `prov-${suffix}`,
      clerkOrgId,
      onboardingStep: 4,
      onboardingCompletedAt: new Date(),
      settings: {
        create: {
          timezone: 'America/Sao_Paulo',
          branding: { primaryColor: '#2E7D32' },
          businessHours: {
            monday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            tuesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            wednesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            thursday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            friday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
            saturday: { closed: false, opensAt: '08:00', closesAt: '13:00' },
            sunday: { closed: true, opensAt: '08:00', closesAt: '13:00' },
          },
          onlineBookingEnabled: options.onlineBookingEnabled ?? true,
          ...(withAddress
            ? {
                addressZip: '04567000',
                addressStreet: 'Rua das Acácias',
                addressNumber: '120',
                addressDistrict: 'Moema',
                addressCity: 'São Paulo',
                addressState: 'SP',
              }
            : {}),
          ...(withContact ? { publicPhone: '+551132654321', publicWhatsapp: '+5511987654321' } : {}),
        },
      },
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Administrador de Teste',
    },
  })

  await ownerPrisma.membership.create({
    data: { tenantId, userId: user.id, roleKey: 'TENANT_ADMIN', status: 'ACTIVE' },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return { tenantId, slug, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

export interface ServiceOptions {
  name?: string
  category?: 'BATH' | 'GROOMING' | 'VET' | 'TAXI'
  active?: boolean
  showOnSite?: boolean
  priceCents?: number[]
}

/** Um serviço de catálogo, opcionalmente com tabela de preços por porte. */
export async function givenService(
  fixture: TenantFixture,
  options: ServiceOptions = {},
): Promise<string> {
  const sizes = await ownerPrisma.size.findMany({ where: { tenantId: null }, take: 3 })

  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Banho',
        category: options.category ?? 'BATH',
        baseDurationMin: 60,
        active: options.active ?? true,
        showOnSite: options.showOnSite ?? true,
      },
    })

    for (const [index, priceCents] of (options.priceCents ?? []).entries()) {
      const size = sizes[index]
      if (!size) break
      await tx.servicePricing.create({
        data: {
          tenantId: fixture.tenantId,
          serviceId: service.id,
          sizeId: size.id,
          priceCents: BigInt(priceCents),
          durationMin: 60,
        },
      })
    }

    return service.id
  })
}

export async function givenTutor(fixture: TenantFixture, phoneHash: string): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: 'Ana Souza',
        phoneEncrypted: 'v1:x:x:x',
        phoneHash,
      },
    })
    return tutor.id
  })
}


export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/**
 * Recepção: trabalha os contatos, não publica o site (§9).
 *
 * Cria um segundo membro no tenant, porque o papel agora vem do `membership` e não de
 * uma lista no teste. A matriz dá a ela `site:read_leads` sem `site:manage` — que é
 * exatamente a distinção que os testes de permissão exercitam.
 */
export async function asReceptionist(fixture: TenantFixture): Promise<Caller> {
  return asRole(fixture, 'RECEPTIONIST')
}
