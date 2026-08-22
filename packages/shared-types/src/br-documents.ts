/**
 * Formatos brasileiros: CPF, CNPJ, telefone E.164 e CEP.
 *
 * Vive em `shared-types` porque backend e frontend precisam da **mesma** regra: o
 * formulário rejeita o CPF inválido antes de sair da tela, e o serviço rejeita de
 * novo — validação de cliente é conveniência, nunca a garantia.
 */

/** Sequências que passam no dígito verificador mas não existem (111.111.111-11 etc.). */
const REPEATED_DIGITS = /^(\d)\1+$/

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/** Dígitos verificadores do CPF (módulo 11). */
export function isValidCPF(value: string): boolean {
  const digits = onlyDigits(value)
  if (digits.length !== 11 || REPEATED_DIGITS.test(digits)) return false

  const check = (length: number): number => {
    let sum = 0
    for (let i = 0; i < length; i += 1) {
      sum += Number(digits[i]) * (length + 1 - i)
    }
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }

  return check(9) === Number(digits[9]) && check(10) === Number(digits[10])
}

/** Dígitos verificadores do CNPJ (módulo 11 com pesos cíclicos de 2 a 9). */
export function isValidCNPJ(value: string): boolean {
  const digits = onlyDigits(value)
  if (digits.length !== 14 || REPEATED_DIGITS.test(digits)) return false

  const check = (length: number): number => {
    let sum = 0
    let weight = length - 7
    for (let i = 0; i < length; i += 1) {
      sum += Number(digits[i]) * weight
      weight -= 1
      if (weight < 2) weight = 9
    }
    const remainder = sum % 11
    return remainder < 2 ? 0 : 11 - remainder
  }

  return check(12) === Number(digits[12]) && check(13) === Number(digits[13])
}

/**
 * DDDs em que o celular já recebeu o nono dígito. Hoje são todos, mas a lista é
 * explícita: RN-04 fala em "quando o DDD exigir", e um número fixo de 8 dígitos
 * continua sendo um telefone válido que **não** deve ganhar o 9.
 */
const VALID_AREA_CODES = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77,
  79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
])

/** Prefixos de celular. Fixo começa em 2–5; celular, em 6–9. */
function isMobilePrefix(first: string): boolean {
  return Number(first) >= 6
}

export class InvalidPhoneError extends Error {}

/**
 * Normaliza para E.164 (`+55DDDNNNNNNNN`) — RN-04.
 *
 * Aceita com ou sem `+`, com ou sem o 55, com ou sem máscara. Celular de 8 dígitos
 * com prefixo 6–9 recebe o nono dígito; fixo de 8 dígitos é preservado como está.
 */
export function normalizePhoneBR(value: string): string {
  let digits = onlyDigits(value)

  if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2)
  if (digits.length < 10 || digits.length > 11) {
    throw new InvalidPhoneError('Telefone inválido')
  }

  const areaCode = Number(digits.slice(0, 2))
  if (!VALID_AREA_CODES.has(areaCode)) {
    throw new InvalidPhoneError('DDD inválido')
  }

  let subscriber = digits.slice(2)
  const first = subscriber[0] ?? ''

  if (subscriber.length === 8 && isMobilePrefix(first)) {
    // Celular antigo, de antes do nono dígito: o cadastro velho do petshop está
    // cheio deles, e sem o 9 o WhatsApp não entrega.
    subscriber = `9${subscriber}`
  }
  if (subscriber.length === 9 && !isMobilePrefix(first)) {
    throw new InvalidPhoneError('Telefone inválido')
  }

  return `+55${areaCode.toString().padStart(2, '0')}${subscriber}`
}

export function isValidPhoneBR(value: string): boolean {
  try {
    normalizePhoneBR(value)
    return true
  } catch {
    return false
  }
}

export function isValidCEP(value: string): boolean {
  return /^\d{8}$/.test(onlyDigits(value))
}

// ─── Máscaras de exibição ────────────────────────────────────────────────────
// O PRD §5 define exatamente estes formatos para a resposta da API. Mascarar aqui,
// e não na tela, garante que o dado completo simplesmente não sai do serviço.

/** `12345678901` → `***.***.789-01` */
export function maskCPF(cpf: string): string {
  const digits = onlyDigits(cpf)
  if (digits.length !== 11) return '***.***.***-**'
  return `***.***.${digits.slice(6, 9)}-${digits.slice(9)}`
}

/** `12345678000199` → `**.***.678/0001-99` */
export function maskCNPJ(cnpj: string): string {
  const digits = onlyDigits(cnpj)
  if (digits.length !== 14) return '**.***.***/****-**'
  return `**.***.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
}

/** `+5511987654321` → `(11) *****-4321` */
export function maskPhone(phone: string): string {
  const digits = onlyDigits(phone).replace(/^55/, '')
  if (digits.length < 10) return '(**) *****-****'
  return `(${digits.slice(0, 2)}) *****-${digits.slice(-4)}`
}

/** `maria.silva@exemplo.com` → `ma****@exemplo.com` */
export function maskEmail(email: string): string {
  const [local = '', domain] = email.split('@')
  if (!domain) return '****'
  const visible = local.slice(0, 2)
  return `${visible}${'*'.repeat(Math.max(4, local.length - visible.length))}@${domain}`
}

// ─── Formatação sem mascarar ─────────────────────────────────────────────────

export function formatCPF(cpf: string): string {
  const d = onlyDigits(cpf)
  if (d.length !== 11) return cpf
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}

export function formatCNPJ(cnpj: string): string {
  const d = onlyDigits(cnpj)
  if (d.length !== 14) return cnpj
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}

export function formatPhoneBR(phone: string): string {
  const d = onlyDigits(phone).replace(/^55/, '')
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return phone
}

export function formatCEP(zip: string): string {
  const d = onlyDigits(zip)
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : zip
}
