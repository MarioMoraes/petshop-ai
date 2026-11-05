'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { buscarGlobal, type BuscaHit, type BuscaResultado } from '@/lib/busca-global-action'
import { PawPrintIcon, SearchIcon, UsersIcon, XIcon } from './icons'

const KIND: Record<BuscaHit['kind'], { icon: ReactNode; tone: string; label: string }> = {
  tutor: { icon: <UsersIcon />, tone: 'icon-people', label: 'Tutores' },
  pet: { icon: <PawPrintIcon />, tone: 'icon-pet', label: 'Pets' },
}

/**
 * A busca do topo, portada da Imobiliária (2026-11-05): resultados abrem embaixo da
 * caixa enquanto se digita, em grupos, e o clique leva direto à ficha. Até aqui ela era
 * um `<form action="/tutores">` que prometia pet e só achava tutor.
 *
 * Debounce de 250ms, e o `cancelled` impede a resposta de um termo velho de pintar por
 * cima da do termo novo. `/` foca a caixa, sem roubar a tecla de quem digita num campo.
 */
export function BuscaGlobal() {
  const router = useRouter()
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [q, setQ] = useState('')
  const [results, setResults] = useState<BuscaResultado | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [cursor, setCursor] = useState(0)

  const hits = results ? [...results.tutores, ...results.pets] : []

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      const res = await buscarGlobal(term).catch(() => null)
      if (cancelled) return
      setLoading(false)
      setCursor(0)
      setError(res === null)
      setResults(res)
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: globalThis.KeyboardEvent) {
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  /*
   * O resultado é `<Link>`, e não `<button>` com `router.push`: o clique navegava pelo
   * roteador à mão e não chegava à ficha. Com o link, a navegação é a do Next — e o
   * clique do meio e o "abrir em nova aba" passam a funcionar de graça. O Enter das
   * setas continua no `router.push`, porque ali não há clique.
   */
  function fechar() {
    setOpen(false)
    setQ('')
  }

  function go(hit: BuscaHit) {
    fechar()
    router.push(hit.href)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(hits.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[cursor]
      if (hit) go(hit)
    }
  }

  const groups: Array<[BuscaHit['kind'], BuscaHit[]]> = results
    ? [
        ['tutor', results.tutores],
        ['pet', results.pets],
      ]
    : []
  let running = -1

  return (
    <div className="relative hidden xl:block" ref={boxRef} role="search">
      <div className="aurora-search flex">
        <span className={loading ? 'animate-pulse' : undefined}>
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Buscar tutor, pet ou telefone"
          aria-label="Buscar tutor, pet ou telefone"
          autoComplete="off"
        />
        {q && (
          <button
            type="button"
            onClick={() => {
              setQ('')
              inputRef.current?.focus()
            }}
            aria-label="Limpar Busca"
            className="grid h-5 w-5 place-items-center rounded-full text-subtle hover:text-ink [&_svg]:h-3 [&_svg]:w-3"
          >
            <XIcon />
          </button>
        )}
      </div>

      {open && q.trim().length >= 2 && (
        <div
          role="listbox"
          className="card absolute right-0 top-[calc(100%+8px)] z-30 max-h-[70svh] w-[22rem] overflow-y-auto p-2"
        >
          {error && (
            <p className="px-3 py-4 text-sm text-subtle">A busca não respondeu. Tente de novo.</p>
          )}
          {!error && !loading && results && hits.length === 0 && (
            <p className="px-3 py-4 text-sm text-subtle">Nada encontrado para “{q.trim()}”.</p>
          )}
          {groups.map(([kind, items]) =>
            items.length === 0 ? null : (
              <div key={kind} className="py-1">
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
                  {KIND[kind].label}
                </p>
                {items.map((hit) => {
                  running += 1
                  const index = running
                  return (
                    <Link
                      key={`${hit.kind}-${hit.id}`}
                      href={hit.href}
                      prefetch={false}
                      role="option"
                      aria-selected={index === cursor}
                      onMouseEnter={() => setCursor(index)}
                      onClick={fechar}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition ${
                        index === cursor ? 'bg-black/5' : ''
                      }`}
                    >
                      <span className={`nav-chip ${KIND[kind].tone}`}>{KIND[kind].icon}</span>
                      <span className="min-w-0 leading-tight">
                        <span className="block truncate text-sm font-medium text-ink">
                          {hit.label}
                        </span>
                        {hit.sub && (
                          <span className="block truncate text-xs text-subtle">{hit.sub}</span>
                        )}
                      </span>
                    </Link>
                  )
                })}
              </div>
            ),
          )}
          {hits.length > 0 && (
            <p className="border-t border-black/5 px-3 pb-1 pt-2 text-[11px] text-subtle">
              ↑↓ para navegar · Enter para abrir · Esc para fechar
            </p>
          )}
        </div>
      )}
    </div>
  )
}
