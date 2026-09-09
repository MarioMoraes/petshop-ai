import { decryptWithKey, encryptWithKey, getTenantKey, type TenantTransaction } from '@petshop/db'

/**
 * Campos livres do financeiro, cifrados com a DEK do tenant (§9 do PRD).
 *
 * São quatro, e nenhum deles é dado sensível por definição — todos são por vocação:
 * `internal_notes` do lançamento carrega juízo de valor sobre o titular ("cliente
 * sempre atrasa"), `notes` do pagamento carrega o contexto do recebimento,
 * `proof_url` aponta para um comprovante que pode exibir a conta bancária de um
 * terceiro, e `suspension_reason` do pacote costuma citar o óbito do pet.
 *
 * **Não há dado de cartão aqui — e não deve haver.** `method = CARD_MACHINE_*`
 * registra apenas que a maquininha foi usada; PAN, CVV e dados de portador nunca são
 * coletados, o que mantém o sistema fora do escopo PCI-DSS.
 */

export interface LedgerCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(
  tx: TenantTransaction,
  tenantId: string,
): Promise<LedgerCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

export function encryptOptional(
  cipher: LedgerCipher,
  value: string | null | undefined,
): string | null {
  return value ? cipher.encrypt(value) : null
}

export function decryptOptional(cipher: LedgerCipher, payload: string | null): string | null {
  return payload === null ? null : cipher.decrypt(payload)
}
