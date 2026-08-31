'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { searchTutorsAction, type TutorOption } from './actions'

/**
 * Busca de tutor para vincular ao pet.
 *
 * Existe porque `POST /v1/pets` recusa pet sem exatamente um responsável principal:
 * não dá para cadastrar o animal agora e vincular alguém depois. Um pet sem quem
 * responda por ele é o estado que MOD-PET-02 existe para impedir.
 *
 * Devolve o tutor escolhido e limpa a caixa; quem chama decide o que fazer com ele —
 * o formulário monta a lista de responsáveis, o detalhe cria um vínculo só.
 */

export function TutorPicker({
  label,
  excludeIds = [],
  onSelect,
}: {
  label: string
  /** Tutores já vinculados: aparecem marcados em vez de sumirem da lista. */
  excludeIds?: string[]
  onSelect: (tutor: TutorOption) => void
}) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TutorOption[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([])
      return
    }

    // Espera a digitação parar: uma chamada por tecla inundaria o gateway.
    setSearching(true)
    const timer = setTimeout(() => {
      void searchTutorsAction(query)
        .then(setOptions)
        .finally(() => setSearching(false))
    }, 300)

    return () => {
      clearTimeout(timer)
      setSearching(false)
    }
  }, [query])

  return (
    <div>
      <label className="label" htmlFor="tutorSearch">
        {label}
      </label>
      <div className="relative">
        <input
          id="tutorSearch"
          type="search"
          className="field pr-24"
          placeholder="Buscar tutor por nome, telefone ou CPF"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
        />
        {searching && (
          <span className="hint absolute right-4 top-1/2 -translate-y-1/2">buscando…</span>
        )}
      </div>

      {query.trim().length >= 2 && !searching && options.length === 0 && (
        <p className="hint mt-2">
          Nenhum tutor encontrado.{' '}
          <Link href="/tutores/novo" className="underline">
            Cadastrar um novo
          </Link>
          .
        </p>
      )}

      {options.length > 0 && (
        <ul className="mt-2 space-y-1">
          {options.map((tutor) => {
            const already = excludeIds.includes(tutor.id)
            return (
              <li key={tutor.id}>
                <button
                  type="button"
                  disabled={already}
                  onClick={() => {
                    onSelect(tutor)
                    setQuery('')
                    setOptions([])
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-2xl border border-line px-4 py-2.5 text-left text-sm transition-colors ${
                    already ? 'cursor-not-allowed opacity-50' : 'hover:bg-black/5'
                  }`}
                >
                  <span className="font-medium">{tutor.displayName}</span>
                  <span className="hint">{already ? 'já vinculado' : tutor.phoneMasked}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
