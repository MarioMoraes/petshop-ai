import { randomUUID } from 'node:crypto'
import { asRole, ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-PET — a ficha, o catálogo e o álbum.
 *
 * As fixtures ficam por módulo, e não num harness só, porque os nomes colidem: cada
 * módulo tem o seu `givenTenant`, com as configurações que **ele** precisa que
 * existam. O núcleo compartilhado (`../harness.js`) guarda o que é do processo — o
 * app, o banco, o token e os chamadores por papel — e é reexportado aqui para que o
 * teste importe de um lugar só.
 */

export * from '../harness.js'

const { createTenantKey, withTenant } = await import('@petshop/db')
const { setStoragePort } = await import('../../src/shared/storage.js')

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
  /** O gateway resolve o tenant pela Organization do token — daí o campo. */
  clerkOrgId: string
}

/**
 * Cria tenant, usuário e DEK — o mínimo para o pet-service funcionar. Usa o cliente
 * owner porque montar cenário não é o que está sob teste; a partir daí, tudo passa
 * pela API com RLS ativo.
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

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
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
    /**
     * O álbum do pet lê por URL assinada, nunca pelos bytes — `read` existe na porta
     * por causa da galeria do site, que os repassa ao visitante. O dublê o implementa
     * para satisfazer o contrato, e nenhum teste deste módulo o exercita.
     */
    async read(key) {
      const body = objects.get(key)
      return body ? { body, contentType: 'image/webp' } : null
    },
    async put(key, body) {
      if (mode === 'put') {
        const { StorageUnavailableError } = await import('../../src/shared/storage.js')
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

// ─── Chamadores ──────────────────────────────────────────────────────────────

/**
 * O administrador, com o token que o Admin apresentaria. As permissões saem da matriz
 * pelo `membership`, e não de uma lista aqui.
 */
export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/** Um membro do tenant com o papel pedido, para os testes de permissão. */
export async function asRoleIn(fixture: TenantFixture, roleKey: string): Promise<Caller> {
  return asRole(fixture, roleKey)
}
