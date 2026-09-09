import { randomUUID } from 'node:crypto'
import {
  DEFAULT_TERM_VERSION,
  PLATFORM_TERM_SEEDS,
  TERM_KINDS,
} from '@petshop/shared-types'
import { ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-TUTOR — a ficha do cliente, endereços, tags, consentimentos e termos.
 *
 * As fixtures ficam por módulo, e não num harness só, porque os nomes colidem: cada
 * módulo tem o seu `givenTenant`, com as configurações que **ele** precisa que
 * existam. O núcleo compartilhado (`../harness.js`) guarda o que é do processo — o
 * app, o banco, o token e os chamadores por papel — e é reexportado aqui para que o
 * teste importe de um lugar só.
 */

export * from '../harness.js'

const { createTenantKey, withTenant } = await import('@petshop/db')
const { setCepPort } = await import('../../src/modules/tutors/cep-port.js')

export interface FakeCepState {
  entries: Map<string, { street: string; district: string; city: string; state: string }>
  /** Quando definido, a consulta estoura — simula o provedor fora do ar. */
  failWith: Error | null
  calls: number
}

export const fakeCep: FakeCepState = { entries: new Map(), failWith: null, calls: 0 }

export function resetFakeCep(): void {
  fakeCep.entries.clear()
  fakeCep.failWith = null
  fakeCep.calls = 0
  fakeCep.entries.set('01310100', {
    street: 'Avenida Paulista',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'SP',
  })
}
resetFakeCep()

setCepPort({
  async lookup(zipCode) {
    fakeCep.calls += 1
    if (fakeCep.failWith) throw fakeCep.failWith
    const entry = fakeCep.entries.get(zipCode)
    return entry ? { zipCode, ...entry } : null
  },
})

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
  /** O gateway resolve o tenant pela Organization do token — daí o campo. */
  clerkOrgId: string
}

/**
 * Cria tenant, usuário e DEK — o mínimo para o tutor-service funcionar. Usa o
 * cliente owner porque montar cenário não é o que está sob teste; a partir daí,
 * tudo passa pela API com RLS ativo.
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
    data: { tenantId, userId: user.id, roleKey: 'TENANT_ADMIN', status: 'ACTIVE' },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  /**
   * As três versões `1.0` da plataforma, como o provisionamento semeia (MOD-DOC-06).
   *
   * Sem elas nenhum tutor é criado: desde o MOD-DOC-06 toda linha de `tutor_consents`
   * tem a versão conferida contra `term_versions`. O fixture repete o que o
   * `seedTenantDomain` do MOD-IDENT faz, porque o tenant daqui nasce por INSERT
   * e não pelo provisionamento.
   */
  await ownerPrisma.termVersion.createMany({
    data: TERM_KINDS.map((kind) => ({
      tenantId,
      kind,
      version: DEFAULT_TERM_VERSION,
      title: PLATFORM_TERM_SEEDS[kind].title,
      body: PLATFORM_TERM_SEEDS[kind].body,
    })),
  })

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

/**
 * O endereço público do estabelecimento — sem ele, nenhum documento é emitido (AC-02
 * de MOD-DOC-01). Fica fora do `givenTenant` de propósito: é justamente o cenário do
 * tenant incompleto que um dos testes exercita.
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

// ─── Requisições autenticadas ────────────────────────────────────────────────

// ─── Chamadores ──────────────────────────────────────────────────────────────

/**
 * O administrador, com o token que o Admin apresentaria. As permissões saem da matriz
 * pelo `membership`, e não de uma lista aqui.
 */
export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}
