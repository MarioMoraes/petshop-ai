import { Prisma, withTenant } from '@petshop/db'
import { addDays, type PetBirthday, type PetBirthdaysQuery } from '@petshop/shared-types'

/**
 * Quem faz aniversário nos próximos dias — o cartão do Início (Aurora, 2026-11-04).
 *
 * O mesmo critério da campanha de aniversário do MOD-CRM (`crm/birthdays.ts`): só data
 * **exata**, porque uma estimada não tem dia, e o 29 de fevereiro cai no dia 28 em ano
 * comum. A janela é de dias civis do estabelecimento, e quem a calcula é a página.
 */
export async function listPetBirthdays(
  tenantId: string,
  query: PetBirthdaysQuery,
): Promise<{ items: PetBirthday[] }> {
  const dias = Array.from({ length: query.days }, (_, i) => addDays(query.from, i))
  const chaves = new Map<string, string>()
  for (const dia of dias) {
    const [ano, mes, d] = dia.split('-').map(Number) as [number, number, number]
    chaves.set(`${mes}-${d}`, dia)
    const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0
    if (mes === 2 && d === 28 && !bissexto) chaves.set('2-29', dia)
  }
  const pares = [...chaves.keys()].map((k) => {
    const [mes, d] = k.split('-').map(Number)
    return Prisma.sql`(${mes}::int, ${d}::int)`
  })

  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx.$queryRaw<{ id: string; name: string; species: string; species_key: string; birth_date: Date }[]>`
      SELECT p.id, p.name, s.label AS species, s.key AS species_key, p.birth_date
        FROM pets p
        JOIN species s ON s.id = p.species_id
       WHERE p.deleted_at IS NULL
         AND p.status = 'ACTIVE'
         AND p.birth_date IS NOT NULL
         AND p.birth_date_precision = 'EXACT'
         AND (EXTRACT(MONTH FROM p.birth_date)::int, EXTRACT(DAY FROM p.birth_date)::int)
             IN (${Prisma.join(pares)})
    `,
  )

  return {
    items: rows
      .map((row) => {
        const nascimento = row.birth_date.toISOString().slice(0, 10)
        const [anoN, mesN, diaN] = nascimento.split('-').map(Number) as [number, number, number]
        const date = chaves.get(`${mesN}-${diaN}`)!
        return {
          petId: row.id,
          name: row.name,
          speciesName: row.species,
          speciesKey: row.species_key,
          date,
          turning: Number(date.slice(0, 4)) - anoN,
        }
      })
      .filter((item) => item.turning > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
  }
}
