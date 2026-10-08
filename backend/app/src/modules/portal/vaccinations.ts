import { withTenant } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  currentDoses,
  todayIn,
  vaccinationStatus,
  type Vaccination,
  type VaccinationCard,
} from '@petshop/shared-types'
import { assertLinked } from './timeline.js'

/**
 * A carteira de vacinação do pet, vista pelo tutor (MOD-PRONT-08, RN-09).
 *
 * Leitura direta no banco, como todo o Portal: ler é escolher um recorte. O recorte aqui
 * é um só, e acontece na consulta — **a dose anulada não sai**. Para a equipe ela fica
 * no histórico, riscada, porque o erro corrigido também é prova; para o tutor, uma vacina
 * riscada na carteira do próprio cachorro é uma pergunta sem resposta na tela.
 *
 * O resto vai como está: lote, fabricante e o nome e CRMV de quem aplicou são o que a
 * carteira de papel também traz.
 */
export async function readOwnPetVaccinations(
  tenantId: string,
  tutorId: string,
  petId: string,
): Promise<VaccinationCard> {
  return withTenant(tenantId, async (tx) => {
    await assertLinked(tx, tutorId, petId)

    const [rows, settings] = await Promise.all([
      tx.vaccination.findMany({
        where: { petId, voidedAt: null },
        orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      tx.tenantSettings.findFirst({ select: { timezone: true } }),
    ])

    const today = todayIn(settings?.timezone ?? DEFAULT_TIMEZONE)
    const history: Vaccination[] = rows.map((row) => ({
      id: row.id,
      petId: row.petId,
      attendanceId: row.attendanceId,
      origin: row.origin,
      vaccineKey: row.vaccineKey,
      vaccineLabel: row.vaccineLabel,
      appliedAt: isoDate(row.appliedAt),
      nextDoseAt: row.nextDoseAt ? isoDate(row.nextDoseAt) : null,
      manufacturer: row.manufacturer,
      batch: row.batch,
      batchExpiresAt: row.batchExpiresAt ? isoDate(row.batchExpiresAt) : null,
      vetName: row.vetName,
      crmv: row.crmv,
      externalClinic: row.externalClinic,
      createdAt: row.createdAt.toISOString(),
      voidedAt: null,
      voidReason: null,
    }))
    const current = currentDoses(history)

    return { status: vaccinationStatus(current, today), today, current, history }
  })
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}
