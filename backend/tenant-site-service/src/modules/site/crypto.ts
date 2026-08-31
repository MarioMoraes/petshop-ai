import { decryptWithKey, encryptWithKey, getTenantKey, type TenantTransaction } from '@petshop/db'

/**
 * Telefone e e-mail do lead, cifrados com a DEK do tenant (§4).
 *
 * Mesma construção do tutor e da corrida, e aqui a justificativa é a mais forte do
 * sistema: o lead é **dado pessoal de terceiro que ainda não é cliente**. Não há
 * relação contratual que justifique guardá-lo em claro, e o nome fica em claro apenas
 * porque é o que a fila precisa exibir para ser trabalhável — telefone e e-mail, que
 * são as chaves de contato, não.
 */

export interface SiteCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(tx: TenantTransaction, tenantId: string): Promise<SiteCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

export function decryptOptional(cipher: SiteCipher, payload: string | null): string | null {
  return payload === null ? null : cipher.decrypt(payload)
}
