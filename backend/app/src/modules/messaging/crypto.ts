import { decryptWithKey, encryptWithKey, getTenantKey, type TenantTransaction } from '@petshop/db'

/**
 * Destinatário e corpo da mensagem, cifrados com a DEK do tenant (§4 do PRD).
 *
 * O corpo é o dado mais sensível que este serviço guarda, e por um motivo que não é
 * óbvio: sozinho, ele é um perfil pronto. "Oi Ana, o Thor tem banho amanhã às 9h na
 * unidade da Vila Mariana e você deve R$ 180" tem nome, animal, rotina, endereço
 * aproximado e situação financeira em uma frase — mais do que qualquer coluna isolada
 * do cadastro entrega.
 */

export interface MessageCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(tx: TenantTransaction, tenantId: string): Promise<MessageCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

export function encryptOptional(
  cipher: MessageCipher,
  value: string | null | undefined,
): string | null {
  return value ? cipher.encrypt(value) : null
}

/**
 * Decifra tolerando lixo.
 *
 * A retenção (AC-04 de MOD-CRM-10) e a anonimização (RN-10) **apagam** o corpo em vez
 * de removerem a linha, e um histórico que estoura ao encontrar uma mensagem já
 * expurgada seria um histórico que só funciona nos últimos 24 meses.
 */
export function decryptOrPlaceholder(
  cipher: MessageCipher,
  payload: string | null,
  placeholder = '',
): string {
  if (!payload) return placeholder
  try {
    return cipher.decrypt(payload)
  } catch {
    return placeholder
  }
}
