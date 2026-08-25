import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import { signServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import { PERMISSION_KEYS, type PermissionKey, type RoleKey } from '@petshop/shared-types'

/**
 * Harness dos testes de integração.
 *
 * Sobe o app de verdade — hooks, handler de erro, RLS, triggers, banco — e não
 * substitui nada: o pet-service não tem dependência externa a dublar. Os ACs são
 * verificados contra o comportamento real, incluindo os índices únicos parciais que
 * sustentam RN-04 e RN-15.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_pet'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

// Broker e cache ficam fora: os testes verificam o efeito no banco, e subir
// RabbitMQ/Redis por teste só adicionaria intermitência.
process.env.DISABLE_EVENTS = 'true'
// A grade não roda na suíte: um `setInterval` de um minuto é intermitência garantida.
process.env.DISABLE_JOBS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { buildApp } = await import('../src/app.js')
const { loadEnv } = await import('../src/env.js')
const { clearTenantKeyCache, createTenantKey, withTenant } = await import('@petshop/db')

// ─── App ─────────────────────────────────────────────────────────────────────

let app: FastifyInstance | null = null

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp()
  await app.ready()
  return app
}

export async function closeHarness(): Promise<void> {
  await app?.close()
  app = null
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  // `truncateBusinessTables` preserva o catálogo global: ele é semeado uma vez, no
  // global-setup, e recriá-lo a cada teste custaria mais que a suíte inteira.
  await truncateBusinessTables(ownerPrisma)
  // As DEKs são cacheadas por processo; sem limpar, o tenant seguinte reutilizaria
  // a chave do anterior e a decifragem falharia.
  clearTenantKeyCache()
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
}

/**
 * Cria tenant, usuário e DEK — o mínimo para o pet-service funcionar. Usa o cliente
 * owner porque montar cenário não é o que está sob teste; a partir daí, tudo passa
 * pela API com RLS ativo.
 */
export async function givenTenant(name = 'Petshop Teste'): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug: `teste-${suffix}`,
      name,
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
    data: { tenantId, userId: user.id, roleKey: 'TENANT_ADMIN' },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId }
}

/**
 * Tutor criado direto no banco, com a DEK do tenant.
 *
 * O pet-service lê tutores mas não os cria — quem cadastra é o tutor-service, e
 * chamá-lo daqui acoplaria as duas suítes. O que importa para os testes de vínculo é
 * a linha existir com o telefone cifrado de verdade, para o mascaramento do mapper
 * ser exercitado.
 */
export async function givenTutor(fixture: TenantFixture, fullName = 'Maria Silva'): Promise<string> {
  const { encryptWithKey, getTenantKey, hashSearchable } = await import('@petshop/db')

  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const phone = `+5511${Math.floor(900000000 + Math.random() * 99999999)}`
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        personType: 'PF',
        fullName,
        phoneEncrypted: encryptWithKey(phone, key),
        phoneHash: hashSearchable('tutor:phone', phone),
        status: 'ACTIVE',
      },
    })
    return tutor.id
  })
}

/** Ids do catálogo global, pelas chaves estáveis do seed. */
export interface CatalogFixture {
  speciesDogId: string
  speciesCatId: string
  breedDogId: string
  breedCatId: string
  sizeSmallId: string
  sizeLargeId: string
  coatShortId: string
}

export async function catalogIds(): Promise<CatalogFixture> {
  const [dog, cat, small, large, short] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'CAT', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'SMALL', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'LARGE', tenantId: null } }),
    ownerPrisma.coat.findFirstOrThrow({ where: { key: 'SHORT', tenantId: null } }),
  ])
  const [breedDog, breedCat] = await Promise.all([
    ownerPrisma.breed.findFirstOrThrow({ where: { speciesId: dog.id, tenantId: null } }),
    ownerPrisma.breed.findFirstOrThrow({ where: { speciesId: cat.id, tenantId: null } }),
  ])

  return {
    speciesDogId: dog.id,
    speciesCatId: cat.id,
    breedDogId: breedDog.id,
    breedCatId: breedCat.id,
    sizeSmallId: small.id,
    sizeLargeId: large.id,
    coatShortId: short.id,
  }
}

// ─── Storage de mídia (MOD-PET-04) ───────────────────────────────────────────

const { setStoragePort } = await import('../src/lib/storage.js')

export interface FakeStorage {
  /** Chave → bytes gravados. É o que os testes de EXIF e de exclusão inspecionam. */
  objects: Map<string, Buffer>
  removed: string[]
  /** Liga a falha do AC-04: a partir daqui, todo `put` estoura. */
  failNext(mode: 'put' | 'none'): void
}

/**
 * Storage em memória. O R2 fica de fora da suíte pelo mesmo motivo que o RabbitMQ:
 * o que está sob teste é a regra — cota, magic byte, ordem de gravação —, e depender
 * da rede tornaria isso intermitente.
 */
export function installFakeStorage(): FakeStorage {
  const objects = new Map<string, Buffer>()
  const removed: string[] = []
  let mode: 'put' | 'none' = 'none'

  const fake: FakeStorage = {
    objects,
    removed,
    failNext(next) {
      mode = next
    },
  }

  setStoragePort({
    async put(key, body) {
      if (mode === 'put') {
        const { StorageUnavailableError } = await import('../src/lib/storage.js')
        throw new StorageUnavailableError('bucket indisponível no teste')
      }
      objects.set(key, body)
    },
    async signedUrl(key) {
      return `https://r2.test/${key}?assinada=1`
    },
    async remove(keys) {
      for (const key of keys) {
        objects.delete(key)
        removed.push(key)
      }
    },
  })

  return fake
}

export function clearStorage(): void {
  setStoragePort(null)
}

/** JPEG de verdade, com EXIF e GPS — é o que o RN-12 precisa ter o que apagar. */
export async function jpegWithExif(width = 900, height = 600): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  return sharp({ create: { width, height, channels: 3, background: '#E34A32' } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: 'Petshop Teste' },
      // IFD3 é o bloco de GPS: é o metadado que RN-12 existe para apagar, porque
      // entrega o endereço de casa do tutor junto com a foto do cachorro.
      IFD3: { GPSLatitudeRef: 'S', GPSLongitudeRef: 'W' },
    })
    .toBuffer()
}

/** Monta o corpo multipart à mão: o `inject` do Fastify não tem `FormData` nativo. */
export function multipartBody(
  files: { field?: string; filename: string; contentType: string; content: Buffer }[],
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----petshopteste${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'files'}"; ` +
          `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    )
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

// ─── Requisições autenticadas ────────────────────────────────────────────────

export interface CallerOptions {
  clerkUserId: string
  userId?: string
  tenantId?: string
  role?: RoleKey
  permissions?: PermissionKey[]
  permVersion?: number
}

/** Monta os headers assinados que o gateway produziria. */
export function authHeaders(options: CallerOptions): Record<string, string> {
  const context: ServiceAuthContext = {
    clerkUserId: options.clerkUserId,
    permissions: options.permissions ?? [],
  }
  if (options.userId) context.userId = options.userId
  if (options.tenantId) context.tenantId = options.tenantId
  if (options.role) context.role = options.role
  if (options.permVersion !== undefined) context.permVersion = options.permVersion

  return signServiceHeaders(context, loadEnv().INTERNAL_SERVICE_SECRET)
}

export interface InjectOptions extends CallerOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
  /** Usado pelo upload: o `content-type` carrega o `boundary` do multipart. */
  headers?: Record<string, string>
}

export async function callApi(options: InjectOptions) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    headers: { ...authHeaders(options), ...(options.headers ?? {}) },
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/** Chamada como TENANT_ADMIN do tenant do fixture — o caso mais comum. */
export function asAdmin(fixture: TenantFixture) {
  return {
    clerkUserId: fixture.clerkUserId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'TENANT_ADMIN' as const,
    permissions: [...PERMISSION_KEYS],
  }
}
