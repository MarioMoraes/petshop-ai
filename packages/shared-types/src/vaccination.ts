import { z } from 'zod'
import { addDays } from './timezone.js'

// ─── MOD-PRONT-08 — a carteira de vacinação ──────────────────────────────────
// PRD prontuario_04 §3 (MOD-PRONT-08) e §4 (`vaccinations`).

/**
 * De onde vem o registro.
 *
 * `INTERNAL` é a dose aplicada **aqui**, por um veterinário logado: lote, fabricante,
 * validade e CRMV são obrigatórios, porque é o que rastreia uma reação que só aparece
 * dois dias depois (RN-11). `EXTERNAL` é a carteira de papel que o tutor trouxe de outra
 * clínica — o petshop que só faz banho e tosa precisa dela para lembrar e para saber se o
 * pet está em dia, e exigir lote ali faria a recepção inventar um.
 */
export const VACCINATION_ORIGINS = ['INTERNAL', 'EXTERNAL'] as const
export const VaccinationOriginSchema = z.enum(VACCINATION_ORIGINS)
export type VaccinationOrigin = z.infer<typeof VaccinationOriginSchema>

export const VACCINATION_ORIGIN_LABELS: Record<VaccinationOrigin, string> = {
  INTERNAL: 'Aplicada aqui',
  EXTERNAL: 'Aplicada fora',
}

export interface VaccineCatalogEntry {
  key: string
  label: string
  /** O intervalo do reforço. Só **sugere** a próxima dose: o vet a corrige no formulário. */
  intervalMonths: number
}

/**
 * As vacinas do seletor, por `species.key`.
 *
 * É lista, e não texto livre, para a carteira e o lembrete falarem a mesma língua:
 * "V10" e "v-10" seriam duas vacinas para a regra de "a dose nova substitui a anterior".
 * O intervalo é o reforço anual — a série do filhote (21 a 30 dias) é o caso em que o
 * vet edita a data sugerida. Espécie fora da lista só tem "Outra".
 */
export const VACCINE_CATALOG: Record<string, readonly VaccineCatalogEntry[]> = {
  DOG: [
    { key: 'V8', label: 'V8 (Polivalente)', intervalMonths: 12 },
    { key: 'V10', label: 'V10 (Polivalente)', intervalMonths: 12 },
    { key: 'RABIES', label: 'Antirrábica', intervalMonths: 12 },
    { key: 'KENNEL_COUGH', label: 'Gripe Canina (Tosse dos Canis)', intervalMonths: 12 },
    { key: 'GIARDIA', label: 'Giárdia', intervalMonths: 12 },
    { key: 'LEISHMANIASIS', label: 'Leishmaniose', intervalMonths: 12 },
  ],
  CAT: [
    { key: 'V3', label: 'V3 (Tríplice Felina)', intervalMonths: 12 },
    { key: 'V4', label: 'V4 (Quádrupla Felina)', intervalMonths: 12 },
    { key: 'V5', label: 'V5 (Quíntupla Felina)', intervalMonths: 12 },
    { key: 'RABIES', label: 'Antirrábica', intervalMonths: 12 },
    { key: 'FELV', label: 'FeLV (Leucemia Felina)', intervalMonths: 12 },
  ],
}

/** A chave de "Outra": o nome vem do formulário. */
export const OTHER_VACCINE_KEY = 'OTHER'

export function vaccineCatalogFor(speciesKey: string | null | undefined): readonly VaccineCatalogEntry[] {
  return (speciesKey ? VACCINE_CATALOG[speciesKey] : undefined) ?? []
}

/** A data sugerida da próxima dose: aplicação + intervalo, em `YYYY-MM-DD`. */
export function suggestNextDose(appliedAt: string, intervalMonths: number): string {
  const date = new Date(`${appliedAt}T00:00:00Z`)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + intervalMonths)
  // 31/01 + 1 mês cai em 28/02, e não em 03/03: o fim do mês segura o dia.
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.toISOString().slice(0, 10)
}

/**
 * O que identifica "a mesma vacina" na carteira.
 *
 * É a chave do catálogo; em "Outra", o nome digitado sem caixa nem espaço nas pontas. A
 * regra da dose que substitui a anterior, a do status e a do lembrete usam esta função —
 * e o SQL do lembrete (`crm/vaccines.ts`) repete a mesma expressão.
 */
export function vaccineGroupKey(vaccineKey: string, vaccineLabel: string): string {
  return vaccineKey === OTHER_VACCINE_KEY
    ? `${OTHER_VACCINE_KEY}:${vaccineLabel.trim().toLowerCase()}`
    : vaccineKey
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

const VaccinationBaseSchema = z.object({
  vaccineKey: z.string().min(1).max(40),
  /** Obrigatório em "Outra"; nas do catálogo, o servidor usa o rótulo da lista. */
  vaccineLabel: z.string().trim().max(60).optional(),
  appliedAt: z.iso.date(),
  /** Sem próxima dose, a vacina não gera lembrete — é o caso da dose única. */
  nextDoseAt: z.iso.date().nullable().optional(),
  manufacturer: z.string().trim().max(80).optional(),
  batch: z.string().trim().max(40).optional(),
  batchExpiresAt: z.iso.date().optional(),
  attendanceId: z.uuid().optional(),
})

export const CreateVaccinationSchema = z
  .discriminatedUnion('origin', [
    VaccinationBaseSchema.extend({
      origin: z.literal('INTERNAL'),
      manufacturer: z.string().trim().min(2, 'Informe o fabricante').max(80),
      batch: z.string().trim().min(1, 'Informe o lote').max(40),
      batchExpiresAt: z.iso.date({ error: 'Informe a validade do lote' }),
    }),
    VaccinationBaseSchema.extend({
      origin: z.literal('EXTERNAL'),
      /** Onde foi aplicada, como está na carteira de papel. */
      externalClinic: z.string().trim().max(120).optional(),
    }),
  ])
  .refine(
    (data) => data.vaccineKey !== OTHER_VACCINE_KEY || (data.vaccineLabel?.length ?? 0) >= 2,
    { message: 'Informe o nome da vacina', path: ['vaccineLabel'] },
  )
  .refine((data) => !data.nextDoseAt || data.nextDoseAt > data.appliedAt, {
    message: 'A próxima dose precisa ser depois da aplicação',
    path: ['nextDoseAt'],
  })
export type CreateVaccinationInput = z.output<typeof CreateVaccinationSchema>

/** Registro de vacina não se edita: anula-se com motivo, e a dose certa é lançada de novo. */
export const VoidVaccinationSchema = z.object({
  reason: z.string().trim().min(10, 'Explique em ao menos 10 caracteres por que anular').max(500),
})
export type VoidVaccinationInput = z.output<typeof VoidVaccinationSchema>

// ─── Saída ───────────────────────────────────────────────────────────────────

export const VaccinationSchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  attendanceId: z.uuid().nullable(),
  origin: VaccinationOriginSchema,
  vaccineKey: z.string(),
  vaccineLabel: z.string(),
  appliedAt: z.iso.date(),
  nextDoseAt: z.iso.date().nullable(),
  manufacturer: z.string().nullable(),
  batch: z.string().nullable(),
  batchExpiresAt: z.iso.date().nullable(),
  /** Nome e CRMV de quem aplicou, fotografados no registro. Só em `INTERNAL`. */
  vetName: z.string().nullable(),
  crmv: z.string().nullable(),
  externalClinic: z.string().nullable(),
  createdAt: z.iso.datetime(),
  voidedAt: z.iso.datetime().nullable(),
  voidReason: z.string().nullable(),
})
export type Vaccination = z.infer<typeof VaccinationSchema>

export const VACCINATION_STATUSES = ['UP_TO_DATE', 'DUE_SOON', 'OVERDUE', 'UNKNOWN'] as const
export const VaccinationStatusSchema = z.enum(VACCINATION_STATUSES)
export type VaccinationStatus = z.infer<typeof VaccinationStatusSchema>

export const VACCINATION_STATUS_LABELS: Record<VaccinationStatus, string> = {
  UP_TO_DATE: 'Em Dia',
  DUE_SOON: 'Vence em Breve',
  OVERDUE: 'Atrasada',
  UNKNOWN: 'Sem Registro',
}

/** Quantos dias antes do vencimento a carteira passa a dizer "vence em breve". */
export const VACCINATION_DUE_SOON_DAYS = 30

export const VaccinationCardSchema = z.object({
  status: VaccinationStatusSchema,
  /**
   * Hoje no fuso do petshop, que é contra o que "atrasada" se decide. Vai junto para a
   * tela não refazer a conta com o relógio do navegador — perto da meia-noite os dois
   * discordariam, e o mesmo pet sairia em dia num lugar e atrasado no outro.
   */
  today: z.iso.date(),
  /** A dose vigente de cada vacina — a última não anulada do grupo. */
  current: z.array(VaccinationSchema),
  /** Tudo, da mais recente para a mais antiga, anuladas inclusive. */
  history: z.array(VaccinationSchema),
})
export type VaccinationCard = z.infer<typeof VaccinationCardSchema>

/** Uma vacina vigente com a próxima dose já vencida. */
export interface OverdueVaccine {
  vaccineLabel: string
  nextDoseAt: string
  daysOverdue: number
}

type DatedDose = Pick<Vaccination, 'vaccineKey' | 'vaccineLabel' | 'appliedAt' | 'nextDoseAt' | 'voidedAt'>

/**
 * A dose vigente de cada vacina: a última aplicação não anulada do grupo.
 *
 * A dose nova **supersede** a anterior — a V10 de 2025 com retorno vencido deixa de estar
 * atrasada no dia em que a de 2026 é lançada, sem ninguém mexer no registro velho.
 */
export function currentDoses<T extends DatedDose>(doses: readonly T[]): T[] {
  const latest = new Map<string, T>()
  for (const dose of doses) {
    if (dose.voidedAt) continue
    const key = vaccineGroupKey(dose.vaccineKey, dose.vaccineLabel)
    const seen = latest.get(key)
    if (!seen || dose.appliedAt > seen.appliedAt) latest.set(key, dose)
  }
  return [...latest.values()].sort((a, b) => a.vaccineLabel.localeCompare(b.vaccineLabel, 'pt-BR'))
}

export function overdueVaccines(current: readonly DatedDose[], today: string): OverdueVaccine[] {
  return current
    .filter((dose) => dose.nextDoseAt !== null && dose.nextDoseAt < today)
    .map((dose) => ({
      vaccineLabel: dose.vaccineLabel,
      nextDoseAt: dose.nextDoseAt as string,
      daysOverdue: Math.round(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dose.nextDoseAt}T00:00:00Z`)) / 86_400_000,
      ),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
}

/**
 * O estado da carteira, a partir das doses **vigentes** (`currentDoses`).
 *
 * `UNKNOWN` não é "em dia": é a carteira que ninguém preencheu, e é o que o resumo
 * clínico sempre respondeu antes de existir a tabela. Vacina sem próxima dose (dose
 * única) conta como em dia.
 */
export function vaccinationStatus(current: readonly DatedDose[], today: string): VaccinationStatus {
  if (current.length === 0) return 'UNKNOWN'
  if (overdueVaccines(current, today).length > 0) return 'OVERDUE'

  const soon = addDays(today, VACCINATION_DUE_SOON_DAYS)
  if (current.some((dose) => dose.nextDoseAt !== null && dose.nextDoseAt <= soon)) return 'DUE_SOON'
  return 'UP_TO_DATE'
}

/**
 * "Vacinação atrasada: V10 (Polivalente), vencida há 45 dias" — o aviso do AC-03.
 *
 * Dois-pontos, e não os parênteses do PRD: o rótulo do catálogo já traz os dele, e
 * "(V10 (Polivalente), …)" lia como erro de digitação.
 */
export function overdueMessage(overdue: readonly OverdueVaccine[]): string | null {
  const first = overdue[0]
  if (!first) return null
  const dias = first.daysOverdue === 1 ? '1 dia' : `${first.daysOverdue} dias`
  const others = overdue.length > 1 ? ` e mais ${overdue.length - 1}` : ''
  return `Vacinação atrasada: ${first.vaccineLabel}, vencida há ${dias}${others}`
}
