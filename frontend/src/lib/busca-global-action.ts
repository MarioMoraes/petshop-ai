'use server'

import { serverApi } from './api'

export interface BuscaHit {
  kind: 'tutor' | 'pet'
  id: string
  label: string
  sub: string | null
  href: `/tutores/${string}` | `/pets/${string}`
}

export interface BuscaResultado {
  tutores: BuscaHit[]
  pets: BuscaHit[]
}

/**
 * A busca da barra do topo, no molde da Imobiliária: tutores e pets numa chamada só.
 *
 * Server Action porque o cliente HTTP só existe no servidor — é ele que põe o token. Cada
 * grupo cai sozinho: quem não tem `pet:read` ainda acha tutores, e um 403 de um lado não
 * apaga o outro. A busca é a das listas (`?q=`), com a mesma regra de cada módulo — o
 * telefone e o CPF batem por hash, inteiros, e o nome pelo índice de texto.
 */
export async function buscarGlobal(q: string): Promise<BuscaResultado | null> {
  const term = q.trim().slice(0, 120)
  if (term.length < 2) return { tutores: [], pets: [] }

  const [tutores, pets] = await Promise.all([
    serverApi()
      .listTutors({ q: term, limit: 5 })
      .then((page) =>
        page.data.map(
          (t): BuscaHit => ({
            kind: 'tutor',
            id: t.id,
            label: t.displayName,
            sub: t.phoneMasked,
            href: `/tutores/${t.id}`,
          }),
        ),
      )
      .catch(() => null),
    serverApi()
      .listPets({ q: term, limit: 5 })
      .then((page) =>
        page.data.map(
          (p): BuscaHit => ({
            kind: 'pet',
            id: p.id,
            label: p.name,
            sub: [p.species.label, p.breed?.label].filter(Boolean).join(' · ') || null,
            href: `/pets/${p.id}`,
          }),
        ),
      )
      .catch(() => null),
  ])

  if (tutores === null && pets === null) return null
  return { tutores: tutores ?? [], pets: pets ?? [] }
}
