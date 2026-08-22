import { SLUG_REGEX, isReservedSlug } from './identity.js'

/**
 * Geração de sugestões de slug para o 409 do AC-02 de MOD-IDENT-01
 * ("Sugestões: petshopdojoao-sp, petshopdojoao2") e para o feedback ao vivo
 * da etapa 1 do wizard.
 */

/** Normaliza um nome de petshop em um slug candidato: "Petshop do João" → "petshopdojoao". */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 50)
}

const REGIONAL_SUFFIXES = ['sp', 'rj', 'mg', 'pr', 'rs'] as const

/**
 * Candidatos em ordem de preferência. Quem chama filtra pelos que já existem no
 * banco — esta função é pura para poder ser usada também no frontend.
 */
export function slugSuggestions(base: string, limit = 5): string[] {
  const root = isValidSlug(base) ? base : slugify(base)
  if (!root) return []

  const candidates: string[] = []
  const push = (candidate: string) => {
    const trimmed = candidate.slice(0, 50)
    if (isValidSlug(trimmed) && !isReservedSlug(trimmed) && !candidates.includes(trimmed)) {
      candidates.push(trimmed)
    }
  }

  for (const suffix of REGIONAL_SUFFIXES) push(`${root}-${suffix}`)
  for (let n = 2; n <= 9; n++) push(`${root}${n}`)
  push(`${root}-petshop`)
  push(`${root}-oficial`)

  return candidates.slice(0, limit)
}

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug)
}
