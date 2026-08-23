'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Species } from '@petshop/shared-types'

/**
 * Caixa de busca do balcão.
 *
 * Escreve na URL em vez de guardar estado próprio, e espera a digitação parar antes
 * de navegar — uma requisição por tecla inundaria o gateway sem melhorar nada para
 * quem está com o cliente na frente.
 *
 * O filtro por espécie fica ao lado da busca porque RN-16 admite cinco "Mel" no mesmo
 * tenant: separar cães de gatos é o corte que mais rápido desfaz o empate.
 */

export function PetSearch({
  species,
  initialQuery,
  activeSpeciesId,
}: {
  species: Species[]
  initialQuery: string
  activeSpeciesId: string
}) {
  const router = useRouter()
  const [query, setQuery] = useState(initialQuery)
  const [pending, startTransition] = useTransition()

  function navigate(nextQuery: string, nextSpeciesId: string) {
    const search = new URLSearchParams()
    if (nextQuery) search.set('q', nextQuery)
    if (nextSpeciesId) search.set('speciesId', nextSpeciesId)
    startTransition(() => router.push(`/pets?${search.toString()}`))
  }

  useEffect(() => {
    if (query === initialQuery) return

    const timer = setTimeout(() => {
      const search = new URLSearchParams()
      if (query) search.set('q', query)
      if (activeSpeciesId) search.set('speciesId', activeSpeciesId)
      startTransition(() => router.push(`/pets?${search.toString()}`))
    }, 300)

    return () => clearTimeout(timer)
  }, [query, initialQuery, activeSpeciesId, router])

  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          type="search"
          className="field pr-24"
          placeholder="Buscar por nome, raça, cor ou microchip"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar pets"
        />
        {pending && (
          <span className="hint absolute right-4 top-1/2 -translate-y-1/2">buscando…</span>
        )}
      </div>

      {species.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {species.map((item) => {
            const active = item.id === activeSpeciesId
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(query, active ? '' : item.id)}
                aria-pressed={active}
                className={`pill px-3 py-1 text-xs font-medium transition-colors ${
                  active ? 'bg-shell text-white' : 'bg-black/5 text-muted hover:bg-black/10'
                }`}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
