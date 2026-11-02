import { withTenant } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  formatAgeLabel,
  monthsBetween,
  type BirthDatePrecision,
  type SafetyRecord,
  type VaccinationCard,
} from '@petshop/shared-types'
import { openCipher } from './crypto.js'
import { notFound } from './errors.js'
import { getSafetyRecord } from './service.js'
import { getVaccinationCard } from './vaccinations.js'

/**
 * A ficha do pet para a sala de banho e tosa (MOD-PET-11).
 *
 * É uma folha de **segurança**, e mora no prontuário por isso: o que importa a quem
 * está com o pet na mesa é a alergia, o temperamento e o alerta — com a identificação do
 * animal em volta. A permissão é a do alerta (`record:read_alerts`), que o banhista e o
 * tosador têm; o contato do tutor só entra para quem também tem `tutor:read`, pela mesma
 * regra da folha de vacinas atrasadas: a folha não mostra o que a tela não mostraria.
 */
export interface PetSheet {
  tenantName: string
  timezone: string
  generatedAt: string
  pet: {
    name: string
    species: string
    breed: string | null
    size: string
    coat: string | null
    sex: 'MALE' | 'FEMALE' | 'UNKNOWN'
    ageLabel: string | null
    weightKg: number | null
  }
  /** Nulo quando quem imprime não tem `tutor:read`. */
  tutor: { name: string; phone: string | null } | null
  safety: SafetyRecord
  vaccines: VaccinationCard
}

export async function petSheet(
  tenantId: string,
  petId: string,
  options: { withContact: boolean; now?: Date },
): Promise<PetSheet> {
  const now = options.now ?? new Date()
  const base = await withTenant(tenantId, async (tx) => {
    const pet = await tx.pet.findFirst({
      where: { id: petId, deletedAt: null },
      select: {
        name: true,
        sex: true,
        birthDate: true,
        birthDatePrecision: true,
        weightKg: true,
        species: { select: { label: true } },
        breed: { select: { label: true } },
        size: { select: { label: true } },
        coat: { select: { label: true } },
      },
    })
    if (!pet) throw notFound('Pet não encontrado')

    const [tenant, settings] = await Promise.all([
      tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true } }),
      tx.tenantSettings.findFirst({ select: { timezone: true } }),
    ])

    let tutor: PetSheet['tutor'] = null
    if (options.withContact) {
      const link = await tx.petTutor.findFirst({
        where: { petId, role: 'PRIMARY', unlinkedAt: null },
        select: {
          tutor: { select: { fullName: true, socialName: true, phoneEncrypted: true } },
        },
      })
      if (link) {
        const cipher = await openCipher(tx, tenantId)
        const phone = link.tutor.phoneEncrypted ? cipher.decrypt(link.tutor.phoneEncrypted) : ''
        // RN-14 do MOD-TUTOR: o nome social é o nome exibido.
        tutor = { name: link.tutor.socialName ?? link.tutor.fullName, phone: phone || null }
      }
    }

    const ageMonths = pet.birthDate ? monthsBetween(pet.birthDate, now) : null
    return {
      tenantName: tenant.name,
      timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
      pet: {
        name: pet.name,
        species: pet.species.label,
        breed: pet.breed?.label ?? null,
        size: pet.size.label,
        coat: pet.coat?.label ?? null,
        sex: pet.sex,
        ageLabel: formatAgeLabel(ageMonths, pet.birthDatePrecision as BirthDatePrecision),
        weightKg: pet.weightKg === null ? null : Number(pet.weightKg),
      },
      tutor,
    }
  })

  const [safety, vaccines] = await Promise.all([
    getSafetyRecord(tenantId, petId),
    getVaccinationCard(tenantId, petId),
  ])

  return { ...base, generatedAt: now.toISOString(), safety, vaccines }
}
