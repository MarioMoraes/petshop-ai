import {
  decryptWithKey,
  encryptWithKey,
  getTenantKey,
  hashSearchable,
  normalizeEmail,
  type TenantTransaction,
} from '@petshop/db'
import { onlyDigits } from '@petshop/shared-types'

/**
 * PII do tutor: cifragem com a DEK do tenant e hash de busca com pepper.
 *
 * O par cifra/hash é indivisível — gravar um sem o outro produz um dado que não pode
 * ser encontrado, ou um índice que aponta para nada. Por isso as duas coisas moram
 * aqui, e nenhuma rota chama `encryptWithKey` direto.
 *
 * O namespace do hash separa os campos: sem ele, um CPF e um telefone com os mesmos
 * dígitos colidiriam no índice.
 */

export const HASH_NAMESPACES = {
  cpf: 'tutor:cpf',
  cnpj: 'tutor:cnpj',
  phone: 'tutor:phone',
  email: 'tutor:email',
} as const

export interface TutorCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

/** Abre o cifrador do tenant. A DEK vem do cache em memória depois da 1ª chamada. */
export async function openCipher(
  tx: TenantTransaction,
  tenantId: string,
): Promise<TutorCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

export function hashCpf(cpf: string): string {
  return hashSearchable(HASH_NAMESPACES.cpf, onlyDigits(cpf))
}

export function hashCnpj(cnpj: string): string {
  return hashSearchable(HASH_NAMESPACES.cnpj, onlyDigits(cnpj))
}

/** Espera o telefone já em E.164 — normalizar é responsabilidade do schema. */
export function hashPhone(phoneE164: string): string {
  return hashSearchable(HASH_NAMESPACES.phone, phoneE164)
}

export function hashTutorEmail(email: string): string {
  return hashSearchable(HASH_NAMESPACES.email, normalizeEmail(email))
}

/** Decifra tolerando nulo, que é o caso da maioria das colunas opcionais. */
export function decryptOptional(cipher: TutorCipher, payload: string | null): string | null {
  return payload === null ? null : cipher.decrypt(payload)
}
