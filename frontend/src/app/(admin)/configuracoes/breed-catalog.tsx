'use client'

import { useEffect, useState, useTransition } from 'react'
import type { ManagedBreed, Species } from '@petshop/shared-types'
import { Button, Card, Field, FormError } from '@/components/ui'
import {
  createBreedAction,
  deleteBreedAction,
  listManagedBreedsAction,
  setBreedVisibilityAction,
} from './actions'

/**
 * Catálogo de raças do estabelecimento (MOD-PET-03).
 *
 * RN-02 é a forma da tela: o que veio do catálogo global aparece marcado e não tem
 * botão de editar — só de ocultar. O que o tenant criou é dele e pode sair de vez,
 * desde que nenhum pet esteja usando (AC-04).
 *
 * A lista carrega por espécie, e não inteira: são ~250 raças globais, e ninguém
 * procura "Poodle" numa lista que mistura cão, gato e réptil.
 */

interface Props {
  species: Species[]
  canManage: boolean
}

export function BreedCatalog({ species, canManage }: Props) {
  const [speciesId, setSpeciesId] = useState(species[0]?.id ?? '')
  const [breeds, setBreeds] = useState<ManagedBreed[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!speciesId) return
    let active = true
    setLoading(true)
    listManagedBreedsAction(speciesId)
      .then((rows) => {
        if (active) setBreeds(rows)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    // Evita que a resposta de uma espécie anterior sobrescreva a atual.
    return () => {
      active = false
    }
  }, [speciesId])

  function reload() {
    listManagedBreedsAction(speciesId).then(setBreeds)
  }

  function create(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await createBreedAction({ speciesId, label: label.trim() })
      if (result.ok) {
        setLabel('')
        reload()
      } else {
        setError(result.message)
      }
    })
  }

  function toggle(breed: ManagedBreed) {
    setError(null)
    startTransition(async () => {
      const result = await setBreedVisibilityAction(breed.id, !breed.hidden)
      if (result.ok) reload()
      else setError(result.message)
    })
  }

  function remove(breed: ManagedBreed) {
    setError(null)
    startTransition(async () => {
      const result = await deleteBreedAction(breed.id)
      if (result.ok) reload()
      else setError(result.message)
    })
  }

  const visible = showHidden ? breeds : breeds.filter((breed) => !breed.hidden)
  const hiddenCount = breeds.filter((breed) => breed.hidden).length

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Card className="space-y-4">
        <Field label="Espécie" htmlFor="catalog-species">
          <select
            id="catalog-species"
            className="field"
            value={speciesId}
            onChange={(event) => setSpeciesId(event.target.value)}
          >
            {species.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>

        {canManage && (
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <Field
              label="Nova raça"
              htmlFor="catalog-label"
              hint="Se ela já existir no catálogo, avisamos qual é em vez de duplicar."
            >
              <input
                id="catalog-label"
                className="field w-64"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Ex.: Vira-lata Caramelo"
              />
            </Field>
            <Button
              type="submit"
              busy={pending}
              disabled={label.trim().length < 2}
              busyLabel="Adicionando…"
            >
              Adicionar
            </Button>
          </form>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-semibold">
            {visible.length} {visible.length === 1 ? 'raça' : 'raças'}
          </h3>
          {hiddenCount > 0 && (
            <Button
              type="button"
              className="ml-auto px-3 py-1 text-xs"
              onClick={() => setShowHidden((value) => !value)}
            >
              {showHidden ? 'Esconder ocultas' : `Ver ${hiddenCount} oculta(s)`}
            </Button>
          )}
        </div>

        {loading ? (
          <p className="hint">Carregando…</p>
        ) : (
          <ul className="divide-y divide-black/5">
            {visible.map((breed) => (
              <li key={breed.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className={breed.hidden ? 'text-muted line-through' : ''}>{breed.label}</span>
                {breed.custom ? (
                  <span className="pill bg-accent-soft px-3 py-1 text-xs text-accent-ink">
                    Sua raça
                  </span>
                ) : (
                  <span className="pill bg-black/5 px-3 py-1 text-xs text-muted">Catálogo</span>
                )}
                {breed.petsCount > 0 && (
                  <span className="hint">
                    {breed.petsCount} {breed.petsCount === 1 ? 'pet' : 'pets'}
                  </span>
                )}

                {canManage && (
                  <div className="ml-auto flex flex-wrap gap-2">
                    <Button
                      type="button"
                      className="px-3 py-1 text-xs"
                      busy={pending}
                      onClick={() => toggle(breed)}
                      title={
                        breed.custom
                          ? undefined
                          : 'A raça do catálogo global não é editável — some apenas da sua lista'
                      }
                      busyLabel="Salvando…"
                    >
                      {breed.hidden ? 'Mostrar' : 'Ocultar'}
                    </Button>

                    {/* Só a raça do tenant some de vez, e só quando ninguém a usa. */}
                    {breed.custom && breed.petsCount === 0 && (
                      <Button
                        type="button"
                        className="px-3 py-1 text-xs"
                        busy={pending}
                        onClick={() => remove(breed)}
                        busyLabel="Excluindo…"
                      >
                        Excluir
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {!loading && visible.length === 0 && (
          <p className="hint">Nenhuma raça nesta espécie. Adicione a primeira acima.</p>
        )}
      </Card>
    </div>
  )
}
