import { decryptWithKey, encryptWithKey, getTenantKey, type TenantTransaction } from '@petshop/db'

/**
 * Endereço e campo livre da corrida, cifrados com a DEK do tenant (§4).
 *
 * É a mesma construção do prontuário e do agendamento, mas aqui o motivo é mais
 * direto: rua, número e instrução de acesso são o endereço residencial de uma pessoa
 * natural — dado pessoal na LGPD, sem margem de interpretação. `zip_code`,
 * `district`, `city` e `state` ficam em claro, como em `tutor_addresses`: sozinhos
 * não identificam ninguém e são o que a resolução de zona consulta.
 */

export interface TaxiCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(tx: TenantTransaction, tenantId: string): Promise<TaxiCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

export function encryptOptional(
  cipher: TaxiCipher,
  value: string | null | undefined,
): string | null {
  return value ? cipher.encrypt(value) : null
}

export function decryptOptional(cipher: TaxiCipher, payload: string | null): string | null {
  return payload === null ? null : cipher.decrypt(payload)
}
