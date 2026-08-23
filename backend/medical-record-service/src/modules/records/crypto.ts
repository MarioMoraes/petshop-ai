import { decryptWithKey, encryptWithKey, getTenantKey, type TenantTransaction } from '@petshop/db'

/**
 * Campos clínicos livres, cifrados com a DEK do tenant (PRD prontuario_04 §4).
 *
 * A nota do §4 é honesta sobre o motivo: dado de saúde **animal** não é dado pessoal
 * sensível na LGPD, que trata de pessoa natural. A cifragem aqui atende ao sigilo
 * profissional veterinário (Res. CFMV 1.138/2016) e ao fato de que campo livre
 * clínico costuma mencionar o tutor — "a tutora relatou que ficou internada".
 */

export interface RecordCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(tx: TenantTransaction, tenantId: string): Promise<RecordCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

export function encryptOptional(cipher: RecordCipher, value: string | null | undefined): string | null {
  return value ? cipher.encrypt(value) : null
}

export function decryptOptional(cipher: RecordCipher, payload: string | null): string | null {
  return payload === null ? null : cipher.decrypt(payload)
}
