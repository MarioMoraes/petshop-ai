import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Criptografia de PII em repouso (PRD identidade_tenancy_01 §4).
 *
 * Envelope encryption:
 *   KEK (secret manager) → DEK por tenant (cifrada em `data_keys`) → dado cifrado.
 *
 * A chave de plataforma, usada pelas colunas de `users` — tabela global, sem tenant —,
 * não é guardada no banco: é derivada da KEK por HKDF. Assim `data_keys` continua
 * inteiramente sob RLS, sem nenhuma linha de escopo global para abrir exceção.
 *
 * Formato armazenado: `v1:<iv_base64>:<authTag_base64>:<ciphertext_base64>`.
 */

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

export class CryptoConfigError extends Error {}
export class DecryptionError extends Error {}

let cachedKek: Buffer | null = null
let cachedPlatformKey: Buffer | null = null
let cachedPepper: string | null = null

function readKek(): Buffer {
  if (cachedKek) return cachedKek
  const raw = process.env.ENCRYPTION_KEK
  if (!raw) {
    throw new CryptoConfigError('ENCRYPTION_KEK não configurada — veja .env.example')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `ENCRYPTION_KEK deve ter ${KEY_BYTES} bytes em base64; recebeu ${key.length}`,
    )
  }
  cachedKek = key
  return key
}

function readPepper(): string {
  if (cachedPepper) return cachedPepper
  const pepper = process.env.EMAIL_HASH_PEPPER
  if (!pepper) {
    throw new CryptoConfigError('EMAIL_HASH_PEPPER não configurado — veja .env.example')
  }
  cachedPepper = pepper
  return pepper
}

/** Zera os caches. Só para testes que trocam as variáveis de ambiente. */
export function resetCryptoCache(): void {
  cachedKek = null
  cachedPlatformKey = null
  cachedPepper = null
}

/**
 * Chave das colunas cifradas de `users`. Derivada da KEK, nunca persistida —
 * rotacionar a KEK rotaciona esta chave junto.
 */
export function platformKey(): Buffer {
  if (cachedPlatformKey) return cachedPlatformKey
  const derived = hkdfSync('sha256', readKek(), Buffer.alloc(0), 'petshop:platform-pii:v1', KEY_BYTES)
  cachedPlatformKey = Buffer.from(derived)
  return cachedPlatformKey
}

export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

export function decryptWithKey(payload: string, key: Buffer): string {
  const parts = payload.split(':')
  if (parts.length !== 4) {
    throw new DecryptionError('Formato de texto cifrado inválido')
  }
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string]
  if (version !== VERSION) {
    throw new DecryptionError(`Versão de criptografia não suportada: ${version}`)
  }

  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(tagB64, 'base64')
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new DecryptionError('IV ou tag de autenticação com tamanho inválido')
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // A falha do GCM significa chave errada ou dado adulterado. Nunca vazar o motivo.
    throw new DecryptionError('Não foi possível decifrar o valor')
  }
}

/** Cifra com a chave de plataforma (colunas de `users`). */
export function encryptPlatform(plaintext: string): string {
  return encryptWithKey(plaintext, platformKey())
}

export function decryptPlatform(payload: string): string {
  return decryptWithKey(payload, platformKey())
}

// ─── DEK por tenant ──────────────────────────────────────────────────────────

export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** Cifra a DEK com a KEK, para gravar em `data_keys.encrypted_dek`. */
export function wrapDek(dek: Buffer): string {
  return encryptWithKey(dek.toString('base64'), readKek())
}

export function unwrapDek(wrapped: string): Buffer {
  const key = Buffer.from(decryptWithKey(wrapped, readKek()), 'base64')
  if (key.length !== KEY_BYTES) {
    throw new DecryptionError('DEK decifrada com tamanho inválido')
  }
  return key
}

// ─── Hash de busca ───────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 com pepper global. Alimenta o índice único `users.email_hash`:
 * é o que torna possível buscar por e-mail sem `LIKE` sobre o texto cifrado.
 * Determinístico por construção — é o preço de poder indexar.
 */
export function hashEmail(email: string): string {
  return createHmac('sha256', readPepper()).update(normalizeEmail(email)).digest('hex')
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * HMAC de busca com namespace (MOD-TUTOR: `cpf_hash`, `phone_hash`, `email_hash`).
 *
 * O namespace entra na mensagem para que o mesmo dígito em campos diferentes gere
 * hashes diferentes — sem ele, um CPF e um telefone que por acaso coincidissem em
 * dígitos casariam entre si, e o hash de um campo vazaria a existência do outro.
 *
 * Determinístico e sem sal por linha, porque é isso que permite indexar: o segredo
 * está no pepper, que fica no secret manager e nunca no banco.
 */
export function hashSearchable(namespace: string, value: string): string {
  return createHmac('sha256', readPepper()).update(`${namespace}:${value}`).digest('hex')
}

/** Comparação de hashes em tempo constante. */
export function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
