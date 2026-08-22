import type { TenantTransaction } from './client.js'
import {
  decryptWithKey,
  encryptWithKey,
  generateDek,
  unwrapDek,
  wrapDek,
} from './crypto.js'

/**
 * DEK por tenant: busca, criação e cache em memória.
 *
 * A DEK vive cifrada pela KEK em `data_keys`, que está sob RLS — então toda função
 * aqui recebe a transação já com contexto de tenant. O cache guarda a chave já
 * decifrada, o que evita um round-trip por campo cifrado; é por processo e some no
 * restart, que é o comportamento desejado para material de chave.
 */

const keyCache = new Map<string, Buffer>()

export function clearTenantKeyCache(tenantId?: string): void {
  if (tenantId) keyCache.delete(tenantId)
  else keyCache.clear()
}

/** Cria a DEK do tenant. Chamada uma vez, no provisionamento. */
export async function createTenantKey(
  tx: TenantTransaction,
  tenantId: string,
): Promise<Buffer> {
  const dek = generateDek()
  await tx.dataKey.create({
    data: { tenantId, encryptedDek: wrapDek(dek) },
  })
  keyCache.set(tenantId, dek)
  return dek
}

export async function getTenantKey(
  tx: TenantTransaction,
  tenantId: string,
): Promise<Buffer> {
  const cached = keyCache.get(tenantId)
  if (cached) return cached

  const row = await tx.dataKey.findUnique({
    where: { tenantId },
    select: { encryptedDek: true },
  })
  if (!row) {
    throw new Error(`Tenant ${tenantId} não possui DEK — provisionamento incompleto`)
  }

  const dek = unwrapDek(row.encryptedDek)
  keyCache.set(tenantId, dek)
  return dek
}

/** Cifra um valor com a DEK do tenant (ex.: `tenants.cnpj`, `invitations.email`). */
export async function encryptForTenant(
  tx: TenantTransaction,
  tenantId: string,
  plaintext: string,
): Promise<string> {
  return encryptWithKey(plaintext, await getTenantKey(tx, tenantId))
}

export async function decryptForTenant(
  tx: TenantTransaction,
  tenantId: string,
  payload: string,
): Promise<string> {
  return decryptWithKey(payload, await getTenantKey(tx, tenantId))
}
