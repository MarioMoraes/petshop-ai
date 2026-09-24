'use client'

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import { SearchIcon, SpinnerIcon, XIcon } from './icons'

/**
 * Caixa de busca das listagens de cadastro — `/pets` e `/tutores`.
 *
 * Escreve na URL em vez de guardar estado próprio, e espera a digitação parar antes
 * de navegar — uma requisição por tecla inundaria o gateway sem melhorar nada para
 * quem está com o cliente na frente. O atendente pode mandar o link, voltar pelo
 * histórico e recarregar a página sem perder o que digitou.
 *
 * Os filtros são uma fila de pílulas logo abaixo, com "Todos" na frente: sem ele, a
 * única forma de desfazer um filtro era clicar de novo no escolhido, o que ninguém
 * descobre sozinho. É a exceção da regra 5 de `docs/design-formularios.md` — na fila
 * de filtros o escolhido é escuro e os outros são claros, porque ali a cor é o estado.
 */

export interface ListFilter {
  value: string
  label: string
  /** Glifo à esquerda — o ícone da espécie. */
  icon?: ReactNode
  /** Cor própria do item — a da etiqueta. Vira um ponto antes do rótulo. */
  color?: string
}

export function ListSearch({
  basePath,
  placeholder,
  ariaLabel,
  initialQuery,
  filterParam,
  filterLabel,
  filters,
  activeFilter,
}: {
  basePath: '/pets' | '/tutores'
  placeholder: string
  ariaLabel: string
  initialQuery: string
  filterParam: string
  /** Nome do grupo de filtros, para o leitor de tela. */
  filterLabel: string
  filters: ListFilter[]
  activeFilter: string
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [pending, startTransition] = useTransition()

  function navigate(nextQuery: string, nextFilter: string) {
    const search = new URLSearchParams()
    if (nextQuery) search.set('q', nextQuery)
    if (nextFilter) search.set(filterParam, nextFilter)
    const qs = search.toString()
    startTransition(() => router.push((qs ? `${basePath}?${qs}` : basePath) as Route))
  }

  useEffect(() => {
    if (query === initialQuery) return
    const timer = setTimeout(() => navigate(query, activeFilter), 300)
    return () => clearTimeout(timer)
    // `navigate` é recriada a cada render e não muda o que o efeito decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, initialQuery, activeFilter])

  function clear() {
    setQuery('')
    inputRef.current?.focus()
  }

  return (
    <div className="space-y-3">
      <div className="field-wrap">
        <span className="field-lead">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="search"
          className="field field-search"
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              clear()
            }
          }}
          aria-label={ariaLabel}
        />
        {/*
          Um slot só para as duas coisas: enquanto a busca está no ar ele gira, e em
          repouso vira o "limpar". Dois ícones lado a lado disputariam o mesmo canto.
        */}
        {pending ? (
          <span className="field-tail text-subtle" role="status" aria-label="Buscando">
            <SpinnerIcon />
          </span>
        ) : (
          query && (
            <button
              type="button"
              onClick={clear}
              className="field-clear"
              aria-label="Limpar a busca"
            >
              <XIcon />
            </button>
          )
        )}
      </div>

      {filters.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={filterLabel}>
          <FilterChip active={!activeFilter} onClick={() => navigate(query, '')}>
            Todos
          </FilterChip>
          {filters.map((filter) => {
            const active = filter.value === activeFilter
            return (
              <FilterChip
                key={filter.value}
                active={active}
                onClick={() => navigate(query, active ? '' : filter.value)}
              >
                {filter.icon}
                {filter.color && (
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: filter.color }}
                  />
                )}
                {filter.label}
              </FilterChip>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`filter-chip ${active ? 'filter-chip-active' : ''}`}
    >
      {children}
    </button>
  )
}
