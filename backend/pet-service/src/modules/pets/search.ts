import { Prisma, type TenantTransaction } from '@petshop/db'
import type { ListPetsQuery } from '@petshop/shared-types'
import { hashMicrochip } from './crypto.js'

/**
 * Busca de pets no balcão. Mesmo desenho da busca de tutores: o formato do que foi
 * digitado escolhe o caminho.
 *
 *   1. **15 dígitos** — é microchip. Vira hash e bate no índice único parcial. `LIKE`
 *      sobre texto cifrado não funcionaria: o mesmo número cifra diferente a cada
 *      gravação.
 *   2. **Texto** — `websearch_to_tsquery` sobre o `search_vector` (nome em 'A', raça
 *      em 'B', cor em 'C'), somado a similaridade trigram no nome. RN-16 admite cinco
 *      "Mel" no mesmo tenant, então a desambiguação é da UI; a busca só precisa
 *      trazer as cinco.
 *   3. **Vazio ou curto** — lista padrão por `updated_at DESC`.
 *
 * Nada é concatenado no SQL: o texto vai por parâmetro e passa por
 * `websearch_to_tsquery`, que trata `&`, `|`, `!` e `:` como texto comum.
 */

export interface SearchResult {
  ids: string[]
  total: number
}

type QueryShape =
  | { kind: 'microchip'; hash: string }
  | { kind: 'text'; value: string }
  | { kind: 'none' }

export function classifyQuery(raw: string | undefined): QueryShape {
  const term = raw?.trim() ?? ''
  if (term.length < 2) return { kind: 'none' }

  const digits = term.replace(/\D/g, '')
  // Só é microchip quando o texto é essencialmente numérico: um nome com um dígito
  // solto continua sendo busca por nome.
  if (digits.length === 15 && digits.length === term.replace(/[\s.-]/g, '').length) {
    return { kind: 'microchip', hash: hashMicrochip(digits) }
  }

  return { kind: 'text', value: term }
}

interface CountRow {
  total: bigint
}

interface IdRow {
  id: string
}

export async function searchPetIds(tx: TenantTransaction, query: ListPetsQuery): Promise<SearchResult> {
  const shape = classifyQuery(query.q)
  const where = buildWhere(query, shape)
  const offset = (query.page - 1) * query.limit

  const [countRows, idRows] = await Promise.all([
    tx.$queryRaw<CountRow[]>(Prisma.sql`SELECT count(*)::bigint AS total FROM "pets" p ${where}`),
    tx.$queryRaw<IdRow[]>(Prisma.sql`
      SELECT p."id" FROM "pets" p
      ${where}
      ORDER BY ${buildOrderBy(shape)}
      LIMIT ${query.limit} OFFSET ${offset}
    `),
  ])

  return { ids: idRows.map((row) => row.id), total: Number(countRows[0]?.total ?? 0) }
}

function buildWhere(query: ListPetsQuery, shape: QueryShape): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`p."deleted_at" IS NULL`]

  if (query.status) {
    conditions.push(Prisma.sql`p."status" = ${query.status}::"PetStatus"`)
  } else {
    // Sem filtro explícito, o pet transferido some: ele agora é de outro tenant, e
    // o registro que ficou existe só para o histórico não perder as referências.
    conditions.push(Prisma.sql`p."status" <> 'TRANSFERRED_OUT'`)
  }

  if (query.speciesId) conditions.push(Prisma.sql`p."species_id" = ${query.speciesId}::uuid`)

  if (query.tutorId) {
    // Só o vínculo vivo: o tutor anterior não vê mais o pet no Portal (RN-07), mas a
    // linha do vínculo encerrado permanece como histórico.
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "pet_tutors" pt
      WHERE pt."pet_id" = p."id"
        AND pt."tutor_id" = ${query.tutorId}::uuid
        AND pt."unlinked_at" IS NULL
    )`)
  }

  switch (shape.kind) {
    case 'microchip':
      conditions.push(Prisma.sql`p."microchip_hash" = ${shape.hash}`)
      break
    case 'text':
      conditions.push(Prisma.sql`(
        p."search_vector" @@ websearch_to_tsquery('portuguese', unaccent(${shape.value}))
        OR p."name" % ${shape.value}
      )`)
      break
    case 'none':
      break
  }

  return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
}

function buildOrderBy(shape: QueryShape): Prisma.Sql {
  if (shape.kind !== 'text') return Prisma.sql`p."updated_at" DESC`

  return Prisma.sql`
    (
      ts_rank(p."search_vector", websearch_to_tsquery('portuguese', unaccent(${shape.value})))
      + similarity(p."name", ${shape.value})
    ) DESC,
    p."updated_at" DESC
  `
}
