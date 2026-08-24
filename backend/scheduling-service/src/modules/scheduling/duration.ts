import { SCHEDULE_GRID_MIN } from '@petshop/shared-types'

/**
 * Cálculo da duração de um item de atendimento (RN-01).
 *
 * A duração é **calculada, nunca digitada**, e sai de dois eixos independentes:
 *
 * 1. **Porte** — `service_pricing.duration_min`, uma tabela editável célula a célula.
 *    Não é multiplicador: a decisão do §11 Q1 matou o fator de porte justamente para
 *    o petshop poder dizer que banho em Golden leva 90 min sem mexer em nada mais.
 * 2. **Pelagem** — `coats.grooming_time_factor`, que multiplica o resultado acima.
 *
 * O segundo eixo é uma **premissa em aberto**, e é por isso que este módulo existe
 * separado: o RN-01 diz "`duration_min` do porte **ou** `base_duration_min × fator`",
 * e esse "ou" não resolve o caso normal, em que os dois existem. Adotamos o produto
 * porque porte e pelagem são ortogonais — um Golden e um Labrador são ambos GRANDE,
 * e um leva muito mais tempo — e porque é a conta que o AC-01 de MOD-AGENDA-04 faz
 * explicitamente (90 × 1,35 = 122 → 135). Se a decisão for outra, muda-se
 * `applyCoatFactor` e nada mais no sistema se move.
 *
 * O arredondamento é **sempre para cima**, na grade de 15 minutos. Para baixo, a
 * agenda prometeria um encaixe que não cabe, e o atraso se propaga pelo dia inteiro.
 */

/** Arredonda para cima na grade da agenda. 122 → 135, 120 → 120. */
export function roundToGrid(minutes: number): number {
  return Math.ceil(minutes / SCHEDULE_GRID_MIN) * SCHEDULE_GRID_MIN
}

/**
 * Aplica o fator de pelagem à duração do porte.
 *
 * Fator ausente (pet sem pelagem cadastrada) é 1: a ausência do dado não pode
 * encurtar nem alongar o atendimento por conta própria.
 */
export function applyCoatFactor(sizeDurationMin: number, coatFactor: number | null): number {
  const factor = coatFactor && coatFactor > 0 ? coatFactor : 1
  return roundToGrid(sizeDurationMin * factor)
}

export interface DurationInput {
  /** `service_pricing.duration_min` do porte do pet. */
  sizeDurationMin: number
  /** `coats.grooming_time_factor`; nulo quando o pet não tem pelagem cadastrada. */
  coatFactor: number | null
  /**
   * A pelagem só afeta serviço que mexe no pelo. Corte de unha em cão de pelo duplo
   * leva o mesmo tempo que em pelo curto, e multiplicar ali inflaria a agenda por
   * um dado irrelevante.
   */
  category: string
}

/** Categorias em que o pelo é o trabalho. */
const COAT_SENSITIVE = new Set(['BATH', 'GROOMING'])

export function resolveItemDuration(input: DurationInput): number {
  if (!COAT_SENSITIVE.has(input.category)) return roundToGrid(input.sizeDurationMin)
  return applyCoatFactor(input.sizeDurationMin, input.coatFactor)
}

/**
 * Duração total de um atendimento: a soma dos itens, já arredondada individualmente.
 *
 * Somar antes de arredondar daria um total menor e criaria um atendimento que não
 * cabe nos próprios itens — dois banhos de 45 min viram 90, não 75.
 */
export function totalDuration(itemDurations: number[]): number {
  return itemDurations.reduce((sum, minutes) => sum + minutes, 0)
}
