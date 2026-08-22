import { Prisma, type TenantTransaction } from '@petshop/db'
import {
  NAME_SIMILARITY_THRESHOLD,
  isValidCNPJ,
  isValidCPF,
  isValidPhoneBR,
  maskCPF,
  maskPhone,
  normalizePhoneBR,
  onlyDigits,
  type CheckDuplicatesInput,
  type CheckDuplicatesResult,
  type DuplicateCandidate,
  type DuplicateConfidence,
} from '@petshop/shared-types'
import { hashCnpj, hashCpf, hashPhone, hashTutorEmail, openCipher } from './crypto.js'

/**
 * Deduplicação (MOD-TUTOR-02).
 *
 * Duas forças distintas, e confundi-las é o erro clássico:
 *
 *   · **CPF/CNPJ** identificam a pessoa. Colisão é duplicata de fato → bloqueio (409).
 *   · **Telefone e e-mail** identificam um *canal*. Marido e esposa compartilham
 *     número (RN-02); bloquear aqui impediria o cadastro legítimo do segundo tutor.
 *     Colisão vira alerta, e salvar segue permitido com `duplicateAcknowledged`.
 *
 * O nome sozinho nunca é suficiente: "Maria Silva" existe às dezenas. Ele só conta
 * quando somado a um canal em comum — que é exatamente o que o AC-02 descreve.
 */

interface CandidateRow {
  id: string
  full_name: string
  status: 'ACTIVE' | 'INACTIVE' | 'MERGED' | 'ANONYMIZED'
  phone_encrypted: string
  cpf_encrypted: string | null
  email_hash: string | null
  similarity: number | null
}

const CANDIDATE_COLUMNS = Prisma.sql`
  t."id", t."full_name", t."status", t."phone_encrypted", t."cpf_encrypted", t."email_hash"
`

/** Cadastros terminais não são candidatos: não há o que abrir nem o que reativar. */
const NOT_TERMINAL = Prisma.sql`t."deleted_at" IS NULL AND t."status" <> 'MERGED'`

export interface DuplicateSearch {
  cpfHash?: string | undefined
  cnpjHash?: string | undefined
  phoneHash?: string | undefined
  emailHash?: string | undefined
  fullName?: string | undefined
  excludeTutorId?: string | undefined
}

/** Traduz a entrada crua (que pode vir de um formulário meio preenchido) em hashes. */
export function toSearchKeys(input: CheckDuplicatesInput): DuplicateSearch {
  const cpfDigits = input.cpf ? onlyDigits(input.cpf) : ''
  const cnpjDigits = input.cnpj ? onlyDigits(input.cnpj) : ''

  return {
    cpfHash: isValidCPF(cpfDigits) ? hashCpf(cpfDigits) : undefined,
    cnpjHash: isValidCNPJ(cnpjDigits) ? hashCnpj(cnpjDigits) : undefined,
    phoneHash:
      input.phone && isValidPhoneBR(input.phone)
        ? hashPhone(normalizePhoneBR(input.phone))
        : undefined,
    emailHash: input.email?.includes('@') ? hashTutorEmail(input.email) : undefined,
    fullName: input.fullName,
    excludeTutorId: input.excludeTutorId,
  }
}

/**
 * Duplicata **exata** por documento. É a única que bloqueia o cadastro.
 *
 * Inclui inativos e soft-deleted na busca de propósito: o AC-04 quer "reativar o
 * cadastro existente", não criar um segundo com o mesmo CPF e perder o histórico.
 */
export async function findExactDocumentMatch(
  tx: TenantTransaction,
  keys: Pick<DuplicateSearch, 'cpfHash' | 'cnpjHash' | 'excludeTutorId'>,
): Promise<{ id: string; fullName: string; status: string; phoneEncrypted: string } | null> {
  if (!keys.cpfHash && !keys.cnpjHash) return null

  const documentMatch = keys.cpfHash
    ? Prisma.sql`t."cpf_hash" = ${keys.cpfHash}`
    : Prisma.sql`t."cnpj_hash" = ${keys.cnpjHash}`

  const rows = await tx.$queryRaw<
    { id: string; full_name: string; status: string; phone_encrypted: string }[]
  >(Prisma.sql`
    SELECT t."id", t."full_name", t."status", t."phone_encrypted"
    FROM "tutors" t
    WHERE ${documentMatch}
      AND t."status" <> 'MERGED'
      ${keys.excludeTutorId ? Prisma.sql`AND t."id" <> ${keys.excludeTutorId}::uuid` : Prisma.empty}
    LIMIT 1
  `)

  const row = rows[0]
  return row
    ? {
        id: row.id,
        fullName: row.full_name,
        status: row.status,
        phoneEncrypted: row.phone_encrypted,
      }
    : null
}

/** Candidatos prováveis: telefone, e-mail e nome semelhante. Nunca bloqueiam. */
export async function findProbableDuplicates(
  tx: TenantTransaction,
  tenantId: string,
  keys: DuplicateSearch,
): Promise<CheckDuplicatesResult> {
  const clauses: Prisma.Sql[] = []

  if (keys.cpfHash) clauses.push(Prisma.sql`t."cpf_hash" = ${keys.cpfHash}`)
  if (keys.cnpjHash) clauses.push(Prisma.sql`t."cnpj_hash" = ${keys.cnpjHash}`)
  if (keys.phoneHash) {
    clauses.push(
      Prisma.sql`(t."phone_hash" = ${keys.phoneHash} OR t."phone_alt_hash" = ${keys.phoneHash})`,
    )
  }
  if (keys.emailHash) clauses.push(Prisma.sql`t."email_hash" = ${keys.emailHash}`)
  if (keys.fullName && keys.fullName.length >= 3) {
    clauses.push(
      Prisma.sql`similarity(t."full_name", ${keys.fullName}) >= ${NAME_SIMILARITY_THRESHOLD}`,
    )
  }

  if (clauses.length === 0) return { candidates: [], confidence: null }

  const similarityExpr = keys.fullName
    ? Prisma.sql`similarity(t."full_name", ${keys.fullName})`
    : Prisma.sql`NULL::real`

  const rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT ${CANDIDATE_COLUMNS}, ${similarityExpr} AS "similarity"
    FROM "tutors" t
    WHERE ${NOT_TERMINAL}
      AND (${Prisma.join(clauses, ' OR ')})
      ${keys.excludeTutorId ? Prisma.sql`AND t."id" <> ${keys.excludeTutorId}::uuid` : Prisma.empty}
    ORDER BY "similarity" DESC NULLS LAST
    LIMIT 10
  `)

  if (rows.length === 0) return { candidates: [], confidence: null }

  const cipher = await openCipher(tx, tenantId)

  const candidates: DuplicateCandidate[] = rows.map((row) => {
    const phone = cipher.decrypt(row.phone_encrypted)
    const cpf = row.cpf_encrypted ? cipher.decrypt(row.cpf_encrypted) : null

    const matchedOn: string[] = []
    if (keys.cpfHash && cpf && hashCpf(cpf) === keys.cpfHash) matchedOn.push('cpf')
    if (keys.phoneHash && hashPhone(phone) === keys.phoneHash) matchedOn.push('phone')
    if (keys.emailHash && row.email_hash === keys.emailHash) matchedOn.push('email')

    const similarName = (row.similarity ?? 0) >= NAME_SIMILARITY_THRESHOLD
    if (similarName) matchedOn.push('name')

    return {
      id: row.id,
      fullName: row.full_name,
      phoneMasked: maskPhone(phone),
      cpfMasked: cpf ? maskCPF(cpf) : null,
      status: row.status,
      confidence: scoreCandidate(matchedOn),
      matchedOn,
      similarity: row.similarity,
    }
  })

  return { candidates, confidence: highestConfidence(candidates) }
}

/**
 * AC-02: nome semelhante **somado** a e-mail ou telefone em comum é MEDIUM. Nome
 * sozinho é LOW — informação para o atendente, não motivo para interromper o fluxo.
 */
function scoreCandidate(matchedOn: string[]): DuplicateConfidence {
  if (matchedOn.includes('cpf') || matchedOn.includes('cnpj')) return 'HIGH'
  if (matchedOn.includes('phone') || matchedOn.includes('email')) return 'MEDIUM'
  return 'LOW'
}

const CONFIDENCE_ORDER: DuplicateConfidence[] = ['LOW', 'MEDIUM', 'HIGH']

function highestConfidence(candidates: DuplicateCandidate[]): DuplicateConfidence | null {
  let best: DuplicateConfidence | null = null
  for (const candidate of candidates) {
    if (!best || CONFIDENCE_ORDER.indexOf(candidate.confidence) > CONFIDENCE_ORDER.indexOf(best)) {
      best = candidate.confidence
    }
  }
  return best
}
