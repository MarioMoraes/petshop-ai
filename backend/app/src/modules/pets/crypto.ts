import {
  decryptWithKey,
  encryptWithKey,
  getTenantKey,
  hashSearchable,
  type TenantTransaction,
} from '@petshop/db'

/**
 * Microchip e observações do pet: cifrados com a DEK do tenant.
 *
 * O §4 do PRD descreve uma coluna `microchip` única. AES-GCM é não determinístico —
 * o mesmo número cifra diferente a cada gravação — então um índice único sobre o
 * texto cifrado não detectaria duplicata nenhuma. O par `microchip_encrypted` +
 * `microchip_hash` resolve os dois requisitos: o valor fica ilegível em repouso e o
 * hash com pepper sustenta o índice único parcial de RN-15.
 *
 * Mesmo desenho do MOD-TUTOR, e o namespace do hash é o que impede um microchip de
 * 15 dígitos de colidir com um documento de mesmo valor no índice do tutor.
 */

export const HASH_NAMESPACES = {
  microchip: 'pet:microchip',
} as const

export interface PetCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(tx: TenantTransaction, tenantId: string): Promise<PetCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

/** Espera os 15 dígitos já normalizados — quem normaliza é o schema Zod. */
export function hashMicrochip(microchip: string): string {
  return hashSearchable(HASH_NAMESPACES.microchip, microchip.replace(/\D/g, ''))
}

export function decryptOptional(cipher: PetCipher, payload: string | null): string | null {
  return payload === null ? null : cipher.decrypt(payload)
}
