import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// Precisa acontecer antes do primeiro import de src/client.ts: os clientes Prisma
// leem a env na criação.
config({ path: resolve(repoRoot, '.env'), quiet: true })
// Banco de testes próprio deste pacote: o turbo roda as suítes em paralelo.
process.env.TEST_DATABASE_NAME = 'petshop_test_db'

const { createOwnerClient, createRawAppClient, truncateBusinessTables, useTestDatabase } =
  await import('../src/testing.js')
useTestDatabase()

export const ownerPrisma = createOwnerClient()
export const rawAppPrisma = createRawAppClient()

export async function truncateAll(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
}

export interface SeededTenant {
  id: string
  slug: string
  name: string
}

/** Cria um tenant já provisionado, via superusuário (o "arrange" dos testes). */
export async function seedTenant(label: string): Promise<SeededTenant> {
  const id = randomUUID()
  const slug = `${label}-${randomBytes(4).toString('hex')}`
  await ownerPrisma.tenant.create({
    data: {
      id,
      slug,
      name: `Petshop ${label}`,
      status: 'TRIAL',
      plan: 'STARTER',
      provisioningKey: randomUUID(),
      clerkOrgId: `org_${randomBytes(8).toString('hex')}`,
    },
  })
  return { id, slug, name: `Petshop ${label}` }
}

export async function seedUser(email: string): Promise<{ id: string }> {
  const { encryptPlatform, hashEmail } = await import('../src/crypto.js')
  const id = randomUUID()
  await ownerPrisma.user.create({
    data: {
      id,
      clerkUserId: `user_${randomBytes(8).toString('hex')}`,
      emailEncrypted: encryptPlatform(email),
      emailHash: hashEmail(email),
      fullName: 'Usuário de Teste',
    },
  })
  return { id }
}

export async function seedMembership(
  tenantId: string,
  userId: string,
  roleKey = 'TENANT_ADMIN',
): Promise<{ id: string }> {
  const id = randomUUID()
  await ownerPrisma.membership.create({
    data: { id, tenantId, userId, roleKey, status: 'ACTIVE' },
  })
  return { id }
}

export async function disconnectHelpers(): Promise<void> {
  await Promise.all([ownerPrisma.$disconnect(), rawAppPrisma.$disconnect()])
}
