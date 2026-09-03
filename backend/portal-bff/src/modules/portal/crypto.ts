import { randomInt, timingSafeEqual } from 'node:crypto'
import {
  hashSearchable,
  normalizeEmail,
  type TenantTransaction,
  decryptWithKey,
  encryptWithKey,
  getTenantKey,
} from '@petshop/db'
import {
  PORTAL_IDENTIFIER_HASH_NAMESPACE,
  TUTOR_EMAIL_HASH_NAMESPACE,
  TUTOR_PHONE_HASH_NAMESPACE,
  onlyDigits,
  type PortalChannel,
} from '@petshop/shared-types'

/**
 * Os hashes do Portal, e a única coisa que este serviço decifra.
 *
 * Três namespaces distintos, com propósitos distintos, e confundi-los é o defeito que
 * este arquivo existe para evitar:
 *
 * - `tutor:phone` e `tutor:email` **procuram a ficha**. São os mesmos que o
 *   tutor-service grava; um literal divergente de um lado faria a busca nunca casar,
 *   em silêncio, e o Portal responderia "não é cliente" a quem é.
 * - `portal:identifier` **conta a tentativa**. Vale inclusive para identificador que
 *   não corresponde a ficha nenhuma, e é o que sustenta a resposta uniforme do RN-04.
 */

/** O identificador digitado, normalizado para virar chave de busca. */
export function normalizeIdentifier(identifier: string, channel: PortalChannel): string {
  return channel === 'EMAIL' ? normalizeEmail(identifier) : toE164(identifier)
}

/**
 * Telefone brasileiro para E.164, o formato em que `tutors.phone_hash` foi calculado.
 *
 * O tutor digita como fala — com parênteses, traço, com ou sem o 55 na frente. Sem esta
 * normalização o hash não casa e a ficha existente responde como inexistente, que é
 * exatamente o modo de falha invisível deste módulo.
 */
export function toE164(raw: string): string {
  const digits = onlyDigits(raw)
  if (digits.startsWith('55')) return `+${digits}`
  return `+55${digits}`
}

export function hashTutorPhone(phoneE164: string): string {
  return hashSearchable(TUTOR_PHONE_HASH_NAMESPACE, phoneE164)
}

export function hashTutorEmail(email: string): string {
  return hashSearchable(TUTOR_EMAIL_HASH_NAMESPACE, normalizeEmail(email))
}

/** O hash da **tentativa**, para rate limit e cooldown. Nunca procura ficha. */
export function hashIdentifier(normalized: string): string {
  return hashSearchable(PORTAL_IDENTIFIER_HASH_NAMESPACE, normalized)
}

/**
 * O código de seis dígitos.
 *
 * `randomInt` do `node:crypto`, e não `Math.random()`: o gerador não criptográfico do
 * JavaScript é previsível a partir de algumas saídas, e um código de acesso previsível
 * dispensa o atacante de adivinhar.
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * O código guardado é hash, e a comparação é em tempo constante.
 *
 * Guardar o código legível daria a quem lesse a tabela — um dump, um backup, um SELECT
 * de suporte — o acesso à ficha de todo mundo que estivesse tentando entrar naquele
 * minuto.
 */
export function hashCode(challengeId: string, code: string): string {
  return hashSearchable(`portal:code:${challengeId}`, code)
}

export function codeMatches(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored, 'hex')
  const b = Buffer.from(candidate, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * O contato do tutor, decifrado para mascarar o destino na resposta.
 *
 * Acontece **dentro** da transação do tenant, com a DEK dele. O RN-16 diz que o BFF não
 * guarda dado pessoal — não diz que ele nunca o vê: o que a regra proíbe é a cópia
 * local, e aqui o valor morre no fim da requisição.
 */
export async function decryptTutorContact(
  tx: TenantTransaction,
  tenantId: string,
  payload: string,
): Promise<string> {
  const key = await getTenantKey(tx, tenantId)
  return decryptWithKey(payload, key)
}

/**
 * A DEK do tenant, aberta uma vez por transação.
 *
 * `getTenantKey` vai ao banco buscar a chave envelopada e a desembrulha com a KEK; pedir
 * uma por campo faria a ficha de um pet custar três dessas. O mesmo desenho do
 * `openCipher` do pet-service e do tutor-service, e é de propósito que os três sejam
 * iguais: o dia em que a rotação de chave mudar o mecanismo, muda nos três do mesmo jeito.
 */
export interface PortalCipher {
  encrypt(plaintext: string): string
  decrypt(payload: string): string
}

export async function openCipher(
  tx: TenantTransaction,
  tenantId: string,
): Promise<PortalCipher> {
  const key = await getTenantKey(tx, tenantId)
  return {
    encrypt: (plaintext) => encryptWithKey(plaintext, key),
    decrypt: (payload) => decryptWithKey(payload, key),
  }
}

/**
 * Decifra o que pode não estar lá.
 *
 * String vazia devolve `null` e não estoura: o tutor anonimizado do MOD-TUTOR-08 tem
 * `phone_encrypted = ''`, e a mesma forma aparece em qualquer coluna que a
 * anonimização esvaziou. Uma ficha inteira não pode cair por causa de um campo apagado
 * de propósito.
 */
export function decryptOptional(
  cipher: PortalCipher,
  payload: string | null | undefined,
): string | null {
  if (!payload) return null
  return cipher.decrypt(payload)
}
