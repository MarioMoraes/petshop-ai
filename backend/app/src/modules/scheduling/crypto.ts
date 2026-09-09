import { decryptWithKey, encryptWithKey, getTenantKey, type TenantTransaction } from '@petshop/db'

/**
 * Campos livres do agendamento, cifrados com a DEK do tenant (§9 do PRD da agenda).
 *
 * São dois: `notes` e `cancel_reason`. Nenhum dos dois é dado sensível por definição,
 * e os dois são por vocação: a observação do agendamento costuma carregar dado do
 * tutor ("tocar o interfone 2, a sogra abre") e o motivo do cancelamento costuma
 * carregar o porquê ("a tutora foi internada"). Campo livre onde cabe qualquer coisa
 * acaba recebendo qualquer coisa.
 */

export interface SchedulingCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(
  tx: TenantTransaction,
  tenantId: string,
): Promise<SchedulingCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

export function encryptOptional(
  cipher: SchedulingCipher,
  value: string | null | undefined,
): string | null {
  return value ? cipher.encrypt(value) : null
}

export function decryptOptional(
  cipher: SchedulingCipher,
  payload: string | null,
): string | null {
  return payload === null ? null : cipher.decrypt(payload)
}
