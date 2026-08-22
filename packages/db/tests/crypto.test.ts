import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { disconnectHelpers, ownerPrisma, seedTenant, truncateAll } from './helpers.js'

const {
  DecryptionError,
  decryptPlatform,
  disconnectPrisma,
  encryptPlatform,
  generateDek,
  hashEmail,
  hashEquals,
  normalizeEmail,
  unwrapDek,
  withTenant,
  wrapDek,
} = await import('../src/index.js')
const { createTenantKey, decryptForTenant, encryptForTenant, clearTenantKeyCache } =
  await import('../src/tenant-keys.js')

/** PII em repouso — PRD identidade_tenancy_01 §4. */

beforeEach(async () => {
  await truncateAll()
  clearTenantKeyCache()
})

afterAll(async () => {
  await Promise.all([disconnectHelpers(), disconnectPrisma()])
})

describe('envelope AES-256-GCM', () => {
  it('faz round-trip do valor', () => {
    const email = 'joao@petshop.test'
    expect(decryptPlatform(encryptPlatform(email))).toBe(email)
  })

  it('grava no formato v1:<iv>:<tag>:<ct>', () => {
    const parts = encryptPlatform('joao@petshop.test').split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
  })

  it('produz texto cifrado diferente a cada chamada (IV aleatório)', () => {
    const a = encryptPlatform('joao@petshop.test')
    const b = encryptPlatform('joao@petshop.test')
    expect(a).not.toBe(b)
    expect(decryptPlatform(a)).toBe(decryptPlatform(b))
  })

  it('nunca deixa o texto claro legível no valor armazenado', () => {
    const encrypted = encryptPlatform('joao@petshop.test')
    expect(encrypted).not.toContain('joao')
    expect(encrypted).not.toContain('petshop.test')
  })

  it('recusa texto cifrado adulterado, em vez de devolver lixo', () => {
    const encrypted = encryptPlatform('joao@petshop.test')
    const [version, iv, tag, ct] = encrypted.split(':') as [string, string, string, string]
    const flipped = Buffer.from(ct, 'base64')
    flipped[0] = (flipped[0] ?? 0) ^ 0xff
    const tampered = [version, iv, tag, flipped.toString('base64')].join(':')

    // O GCM autentica: adulterar o texto invalida a tag.
    expect(() => decryptPlatform(tampered)).toThrow(DecryptionError)
  })

  it('recusa formato e versão inválidos', () => {
    expect(() => decryptPlatform('sem-separadores')).toThrow(DecryptionError)
    expect(() => decryptPlatform('v2:a:b:c')).toThrow(DecryptionError)
  })
})

describe('hash de busca por e-mail', () => {
  it('é determinístico, para servir de índice único', () => {
    expect(hashEmail('joao@petshop.test')).toBe(hashEmail('joao@petshop.test'))
  })

  it('normaliza caixa e espaços antes do hash', () => {
    expect(hashEmail('  JOAO@Petshop.TEST ')).toBe(hashEmail('joao@petshop.test'))
    expect(normalizeEmail(' Joao@Petshop.test ')).toBe('joao@petshop.test')
  })

  it('separa e-mails distintos', () => {
    expect(hashEmail('joao@petshop.test')).not.toBe(hashEmail('maria@petshop.test'))
  })

  it('compara em tempo constante', () => {
    const hash = hashEmail('joao@petshop.test')
    expect(hashEquals(hash, hash)).toBe(true)
    expect(hashEquals(hash, hashEmail('maria@petshop.test'))).toBe(false)
    expect(hashEquals(hash, 'abc')).toBe(false)
  })
})

describe('DEK por tenant', () => {
  it('faz round-trip da DEK envelopada pela KEK', () => {
    const dek = generateDek()
    expect(dek).toHaveLength(32)
    expect(unwrapDek(wrapDek(dek)).equals(dek)).toBe(true)
  })

  it('cifra e decifra com a chave do próprio tenant', async () => {
    const tenant = await seedTenant('crypto')
    const cnpj = '12345678000199'

    const stored = await withTenant(tenant.id, async (tx) => {
      await createTenantKey(tx, tenant.id)
      return encryptForTenant(tx, tenant.id, cnpj)
    })

    expect(stored).not.toContain(cnpj)

    clearTenantKeyCache()
    const readBack = await withTenant(tenant.id, (tx) =>
      decryptForTenant(tx, tenant.id, stored),
    )
    expect(readBack).toBe(cnpj)
  })

  it('não decifra o dado de um tenant com a chave de outro', async () => {
    const tenantA = await seedTenant('crypto-a')
    const tenantB = await seedTenant('crypto-b')

    const encryptedForA = await withTenant(tenantA.id, async (tx) => {
      await createTenantKey(tx, tenantA.id)
      return encryptForTenant(tx, tenantA.id, 'segredo-do-a')
    })
    await withTenant(tenantB.id, (tx) => createTenantKey(tx, tenantB.id))

    clearTenantKeyCache()
    await expect(
      withTenant(tenantB.id, (tx) => decryptForTenant(tx, tenantB.id, encryptedForA)),
    ).rejects.toThrow(DecryptionError)
  })

  it('guarda a DEK cifrada, nunca em claro', async () => {
    const tenant = await seedTenant('crypto-storage')
    const dek = await withTenant(tenant.id, (tx) => createTenantKey(tx, tenant.id))

    const row = await ownerPrisma.dataKey.findUnique({ where: { tenantId: tenant.id } })
    expect(row?.encryptedDek).toBeTruthy()
    expect(row?.encryptedDek).not.toContain(dek.toString('base64'))
    expect(row?.encryptedDek.startsWith('v1:')).toBe(true)
  })
})
