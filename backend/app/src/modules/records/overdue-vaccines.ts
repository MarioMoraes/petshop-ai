import { withTenant } from '@petshop/db'
import { DEFAULT_TIMEZONE, todayIn, type OverdueVaccinesReport } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { openCipher } from './crypto.js'
import { tenantToday } from './vaccinations.js'

interface OverdueRow {
  pets: bigint
  doses: bigint
}

/**
 * Pets com vacina atrasada — o indicador do Início que esperava o dado existir
 * (MOD-PRONT-08).
 *
 * **Atrasada é a regra da carteira, e não uma segunda.** Conta só a dose **vigente** de
 * cada vacina (`currentDoses`): a V10 de 2025 com retorno vencido não conta quando a de
 * 2026 já foi lançada. O grupo do `DISTINCT ON` é a expressão de `vaccineGroupKey`, a
 * mesma que o lembrete repete em `crm/vaccines.ts`; e "antes de hoje" é hoje no fuso do
 * petshop (`tenantToday`), o mesmo dia contra o qual a ficha decide. Uma conta diferente
 * faria o painel apontar um pet que a ficha mostra em dia.
 *
 * Só pet **ativo**, como o lembrete: o número é para agir — ligar para o tutor —, e o
 * inativo é o cliente que já não vem.
 */
export async function overdueVaccines(tenantId: string): Promise<OverdueVaccinesReport> {
  const { rows, today } = await withTenant(tenantId, async (tx) => {
    const today = await tenantToday(tx)
    const rows = await tx.$queryRaw<OverdueRow[]>`
      SELECT COUNT(DISTINCT cur.pet_id) AS pets, COUNT(*) AS doses
        FROM (
          SELECT DISTINCT ON (
                   v.pet_id,
                   CASE WHEN v.vaccine_key = 'OTHER'
                        THEN 'OTHER:' || lower(btrim(v.vaccine_label))
                        ELSE v.vaccine_key END
                 )
                 v.pet_id, v.next_dose_at
            FROM vaccinations v
           WHERE v.voided_at IS NULL
           ORDER BY v.pet_id,
                    CASE WHEN v.vaccine_key = 'OTHER'
                         THEN 'OTHER:' || lower(btrim(v.vaccine_label))
                         ELSE v.vaccine_key END,
                    v.applied_at DESC,
                    v.created_at DESC
        ) cur
        JOIN pets p ON p.id = cur.pet_id
                   AND p.status = 'ACTIVE'
                   AND p.deleted_at IS NULL
       WHERE cur.next_dose_at < ${today}::date
    `
    return { rows, today }
  })

  const row = rows[0]
  return {
    today,
    pets: Number(row?.pets ?? 0),
    doses: Number(row?.doses ?? 0),
  }
}

// ─── A lista, para o PDF ─────────────────────────────────────────────────────

/** Teto de pets na folha. Passou dele, o PDF avisa — como o de contas a receber. */
export const OVERDUE_VACCINES_MAX_PETS = 500

export interface OverdueVaccinesListPet {
  petId: string
  petName: string
  species: string
  breed: string | null
  /** O dono principal; `null` no pet que ficou sem vínculo. */
  tutorName: string | null
  phone: string | null
  /** Da mais atrasada para a menos. */
  vaccines: { label: string; nextDoseAt: string; daysOverdue: number }[]
}

export interface OverdueVaccinesList {
  tenantName: string
  timezone: string
  today: string
  generatedAt: string
  pets: OverdueVaccinesListPet[]
  /** Quantas doses atrasadas há no total, mesmo além do teto. */
  doses: number
  truncated: boolean
}

interface ListRow {
  pet_id: string
  pet_name: string
  species: string
  breed: string | null
  tutor_id: string | null
  full_name: string | null
  social_name: string | null
  phone_encrypted: string | null
  vaccine_label: string
  next_dose_at: Date
}

/**
 * A folha de quem vai ligar: cada pet com vacina atrasada, o dono principal com o
 * telefone, e as vacinas que ele deve — o detalhe do cartão do Início.
 *
 * A seleção é a de `overdueVaccines`, linha por linha; o que muda é o que desce. A ordem
 * é a do atraso mais antigo primeiro, porque é quem mais precisa da ligação.
 */
export async function overdueVaccinesList(
  tenantId: string,
  now: Date = new Date(),
): Promise<OverdueVaccinesList> {
  return withTenant(tenantId, async (tx) => {
    const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
    const timezone = settings?.timezone ?? DEFAULT_TIMEZONE
    const today = todayIn(timezone, now)

    const rows = await tx.$queryRaw<ListRow[]>`
      SELECT cur.pet_id, p.name AS pet_name, s.label AS species, b.label AS breed,
             t.id AS tutor_id, t.full_name, t.social_name, t.phone_encrypted,
             cur.vaccine_label, cur.next_dose_at
        FROM (
          SELECT DISTINCT ON (
                   v.pet_id,
                   CASE WHEN v.vaccine_key = 'OTHER'
                        THEN 'OTHER:' || lower(btrim(v.vaccine_label))
                        ELSE v.vaccine_key END
                 )
                 v.pet_id, v.vaccine_label, v.next_dose_at
            FROM vaccinations v
           WHERE v.voided_at IS NULL
           ORDER BY v.pet_id,
                    CASE WHEN v.vaccine_key = 'OTHER'
                         THEN 'OTHER:' || lower(btrim(v.vaccine_label))
                         ELSE v.vaccine_key END,
                    v.applied_at DESC,
                    v.created_at DESC
        ) cur
        JOIN pets p ON p.id = cur.pet_id
                   AND p.status = 'ACTIVE'
                   AND p.deleted_at IS NULL
        JOIN species s ON s.id = p.species_id
        LEFT JOIN breeds b ON b.id = p.breed_id
        LEFT JOIN LATERAL (
          SELECT pt.tutor_id FROM pet_tutors pt
           WHERE pt.pet_id = p.id AND pt.role = 'PRIMARY' AND pt.unlinked_at IS NULL
           LIMIT 1
        ) owner ON true
        LEFT JOIN tutors t ON t.id = owner.tutor_id
       WHERE cur.next_dose_at < ${today}::date
       ORDER BY cur.next_dose_at ASC, p.name ASC
    `

    const tenant = await tx.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { name: true },
    })
    const cipher = rows.length > 0 ? await openCipher(tx, tenantId) : null

    // A ordem das linhas (atraso mais antigo primeiro) vira a ordem dos pets: o Map
    // guarda a primeira aparição, que é a vacina mais atrasada de cada um.
    const byPet = new Map<string, OverdueVaccinesListPet>()
    for (const row of rows) {
      let pet = byPet.get(row.pet_id)
      if (!pet) {
        pet = {
          petId: row.pet_id,
          petName: row.pet_name,
          species: row.species,
          breed: row.breed,
          // RN-14: quem tem nome social é chamado por ele — e a ligação é comunicação.
          tutorName: row.social_name ?? row.full_name,
          phone:
            cipher && row.phone_encrypted && row.tutor_id
              ? decryptPhone(cipher, row.phone_encrypted, row.tutor_id)
              : null,
          vaccines: [],
        }
        byPet.set(row.pet_id, pet)
      }
      const nextDoseAt = row.next_dose_at.toISOString().slice(0, 10)
      pet.vaccines.push({
        label: row.vaccine_label,
        nextDoseAt,
        daysOverdue: Math.round(
          (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${nextDoseAt}T00:00:00Z`)) / 86_400_000,
        ),
      })
    }

    const pets = [...byPet.values()]
    return {
      tenantName: tenant.name,
      timezone,
      today,
      generatedAt: now.toISOString(),
      pets: pets.slice(0, OVERDUE_VACCINES_MAX_PETS),
      doses: rows.length,
      truncated: pets.length > OVERDUE_VACCINES_MAX_PETS,
    }
  })
}

/**
 * Telefone ilegível não derruba a folha: é incidente de chave, que merece log, e não um
 * erro no lugar da lista — o mesmo critério do relatório de cobrança.
 */
function decryptPhone(
  cipher: { decrypt: (payload: string) => string },
  payload: string,
  tutorId: string,
): string | null {
  try {
    return cipher.decrypt(payload)
  } catch (error) {
    logger.error(
      { err: error, tutorId },
      'falha ao decifrar telefone na lista de vacinas atrasadas',
    )
    return null
  }
}
