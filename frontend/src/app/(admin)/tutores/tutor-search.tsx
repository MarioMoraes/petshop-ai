'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Tag } from '@petshop/shared-types'

/**
 * Caixa de busca do balcão.
 *
 * Escreve na URL em vez de guardar estado próprio, e espera a digitação parar antes
 * de navegar — uma requisição por tecla inundaria o gateway sem melhorar nada para
 * quem está com o cliente na frente.
 */

export function TutorSearch({
  tags,
  initialQuery,
  activeTag,
}: {
  tags: Tag[]
  initialQuery: string
  activeTag: string
}) {
  const router = useRouter()
  const [query, setQuery] = useState(initialQuery)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (query === initialQuery) return

    const timer = setTimeout(() => {
      const search = new URLSearchParams()
      if (query) search.set('q', query)
      if (activeTag) search.set('tag', activeTag)
      startTransition(() => router.push(`/tutores?${search.toString()}`))
    }, 300)

    return () => clearTimeout(timer)
  }, [query, initialQuery, activeTag, router])

  function toggleTag(key: string) {
    const search = new URLSearchParams()
    if (query) search.set('q', query)
    if (key !== activeTag) search.set('tag', key)
    startTransition(() => router.push(`/tutores?${search.toString()}`))
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          type="search"
          className="field pr-24"
          placeholder="Buscar por nome, telefone ou CPF"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar tutores"
        />
        {pending && (
          <span className="hint absolute right-4 top-1/2 -translate-y-1/2">buscando…</span>
        )}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={() => toggleTag(tag.key)}
              aria-pressed={tag.key === activeTag}
              className={`pill px-3 py-1 text-xs font-medium transition-colors ${
                tag.key === activeTag ? 'text-white' : 'bg-black/5 text-muted hover:bg-black/10'
              }`}
              style={tag.key === activeTag ? { backgroundColor: tag.color } : undefined}
            >
              {tag.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
