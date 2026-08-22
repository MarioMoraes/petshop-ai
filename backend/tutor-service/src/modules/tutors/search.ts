import { Prisma, type TenantTransaction } from '@petshop/db'
import {
  isValidCNPJ,
  isValidCPF,
  isValidPhoneBR,
  normalizePhoneBR,
  onlyDigits,
  type ListTutorsQuery,
} from '@petshop/shared-types'
import { hashCnpj, hashCpf, hashPhone, hashTutorEmail } from './crypto.js'

/**
 * Busca de balcão (MOD-TUTOR-06). SLO de 300ms p95, com o cliente na frente.
 *
 * Três caminhos, escolhidos pelo formato do que foi digitado:
 *
 *   1. **Documento ou telefone** — o texto é normalizado e vira hash; a consulta bate
 *      no índice de `*_hash`. Nunca `LIKE` sobre texto cifrado, que além de lento não
 *      funcionaria: o mesmo valor cifra diferente a cada gravação.
 *   2. **Texto** — `websearch_to_tsquery` sobre o `search_vector` (GIN), somado a
 *      similaridade trigram no nome, para tolerar "maria silva" ↔ "Maria da Silva".
 *   3. **Vazio ou curto** — lista padrão por `updated_at DESC` (AC-03).
 *
 * A entrada nunca é concatenada no SQL: tudo vai por parâmetro, e o texto passa por
 * `websearch_to_tsquery`, que trata `&`, `|`, `!` e `:` como texto comum em vez de
 * operadores (AC-03).
 */

export interface SearchResult {
  ids: string[]
  total: number
}

/** O que o texto digitado parece ser. */
type QueryShape =
  | { kind: 'cpf'; hash: string }
  | { kind: 'cnpj'; hash: string }
  | { kind: 'phone'; hash: string }
  | { kind: 'email'; hash: string }
  | { kind: 'text'; value: string }
  | { kind: 'none' }

export function classifyQuery(raw: string | undefined): QueryShape {
  const term = raw?.trim() ?? ''
  if (term.length < 2) return { kind: 'none' }

  if (term.includes('@')) return { kind: 'email', hash: hashTutorEmail(term) }

  const digits = onlyDigits(term)
  // Só trata como documento quando o texto é essencialmente numérico: "Ana 2" tem
  // dígito, mas é busca por nome.
  const mostlyDigits = digits.length >= term.replace(/[\s.\-/()+]/g, '').length

  if (mostlyDigits) {
    if (digits.length === 11 && isValidCPF(digits)) return { kind: 'cpf', hash: hashCpf(digits) }
    if (digits.length === 14 && isValidCNPJ(digits)) return { kind: 'cnpj', hash: hashCnpj(digits) }
    if (isValidPhoneBR(term)) return { kind: 'phone', hash: hashPhone(normalizePhoneBR(term)) }
    // 11 dígitos que não passam no CPF ainda podem ser um celular digitado errado —
    // o `isValidPhoneBR` acima já cobriu; aqui não sobrou formato conhecido.
  }

  return { kind: 'text', value: term }
}

interface CountRow {
  total: bigint
}

interface IdRow {
  id: string
}

/**
 * Devolve só os ids, ordenados. As linhas completas vêm depois por `findMany`, com
 * as tags carregadas — misturar a agregação de relação no SQL cru complicaria a
 * paginação sem ganhar nada.
 */
export async function searchTutorIds(
  tx: TenantTransaction,
  query: ListTutorsQuery,
): Promise<SearchResult> {
  const shape = classifyQuery(query.q)
  const where = buildWhere(query, shape)
  const offset = (query.page - 1) * query.limit

  const [countRows, idRows] = await Promise.all([
    tx.$queryRaw<CountRow[]>(
      Prisma.sql`SELECT count(*)::bigint AS total FROM "tutors" t ${where}`,
    ),
    tx.$queryRaw<IdRow[]>(
      Prisma.sql`
        SELECT t."id" FROM "tutors" t
        ${where}
        ORDER BY ${buildOrderBy(shape)}
        LIMIT ${query.limit} OFFSET ${offset}
      `,
    ),
  ])

  return { ids: idRows.map((row) => row.id), total: Number(countRows[0]?.total ?? 0) }
}

function buildWhere(query: ListTutorsQuery, shape: QueryShape): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`t."deleted_at" IS NULL`]

  if (query.status) {
    conditions.push(Prisma.sql`t."status" = ${query.status}::"TutorStatus"`)
  } else {
    // Sem filtro explícito, os estados terminais somem da listagem: um cadastro
    // MERGED é um ponteiro para outro, e um ANONYMIZED não tem mais nome para exibir.
    conditions.push(Prisma.sql`t."status" NOT IN ('MERGED', 'ANONYMIZED')`)
  }

  switch (shape.kind) {
    case 'cpf':
      conditions.push(Prisma.sql`t."cpf_hash" = ${shape.hash}`)
      break
    case 'cnpj':
      conditions.push(Prisma.sql`t."cnpj_hash" = ${shape.hash}`)
      break
    case 'phone':
      conditions.push(
        Prisma.sql`(t."phone_hash" = ${shape.hash} OR t."phone_alt_hash" = ${shape.hash})`,
      )
      break
    case 'email':
      conditions.push(Prisma.sql`t."email_hash" = ${shape.hash}`)
      break
    case 'text':
      conditions.push(
        Prisma.sql`(
          t."search_vector" @@ websearch_to_tsquery('portuguese', unaccent(${shape.value}))
          OR t."full_name" % ${shape.value}
        )`,
      )
      break
    case 'none':
      break
  }

  if (query.tag) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "tutor_tag_assignments" a
      JOIN "tutor_tags" g ON g."id" = a."tag_id"
      WHERE a."tutor_id" = t."id" AND g."key" = ${query.tag}
    )`)
  }

  // Saldo negativo = deve para o petshop.
  if (query.hasDebt === true) conditions.push(Prisma.sql`t."balance_cents" < 0`)
  if (query.hasDebt === false) conditions.push(Prisma.sql`t."balance_cents" >= 0`)

  if (query.inactiveSince) {
    // Quem nunca foi atendido também é "inativo desde sempre".
    conditions.push(Prisma.sql`(
      t."last_attendance_at" IS NULL
      OR t."last_attendance_at" < ${new Date(query.inactiveSince)}
    )`)
  }

  return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
}

function buildOrderBy(shape: QueryShape): Prisma.Sql {
  if (shape.kind !== 'text') return Prisma.sql`t."updated_at" DESC`

  // Relevância = full-text primeiro, similaridade de nome como desempate. Quem
  // digitou "mari" quer a Maria mais provável no topo, não a mais recente.
  return Prisma.sql`
    (
      ts_rank(t."search_vector", websearch_to_tsquery('portuguese', unaccent(${shape.value})))
      + similarity(t."full_name", ${shape.value})
    ) DESC,
    t."updated_at" DESC
  `
}
