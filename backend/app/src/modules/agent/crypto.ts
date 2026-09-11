import { decryptWithKey, encryptWithKey, getTenantKey, type TenantTransaction } from '@petshop/db'

/**
 * O corpo da conversa, cifrado com a DEK do tenant (§9 do PRD).
 *
 * É o campo mais sensível do módulo, e por uma razão diferente da de todas as outras
 * tabelas: o que está aqui **não tem formato**. Uma coluna de telefone guarda telefone;
 * um turno guarda o que o cliente resolveu escrever, que pode ser o nome do remédio do
 * cachorro, o endereço de casa ou o motivo pelo qual ele não vai poder pagar este mês.
 */

export interface AgentCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(tx: TenantTransaction, tenantId: string): Promise<AgentCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

/**
 * Decifra tolerando lixo.
 *
 * A anonimização do titular (MOD-TUTOR-08) **apaga o corpo** dos turnos e mantém a
 * linha, porque o painel de qualidade conta conversas. Um histórico que estourasse ao
 * encontrar um turno expurgado seria um histórico que só funciona enquanto ninguém
 * exerce o direito do art. 18.
 */
export function decryptOrPlaceholder(
  cipher: AgentCipher,
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
