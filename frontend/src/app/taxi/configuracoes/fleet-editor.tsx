'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { TaxiVehicleResponse } from '@petshop/shared-types'
import { Card, Field, FormError } from '@/components/ui'
import { createVehicleAction, updateVehicleAction } from '../actions'

/**
 * A frota (MOD-TAXI-03).
 *
 * O que a van acrescenta é **um teto**: a capacidade efetiva da corrida é
 * `min(pets por vez do motorista, pets que cabem no carro)`. Sem van cadastrada o
 * sistema funciona — vale só o número do motorista —, e é por isso que este bloco
 * ficou por último no módulo. O preço de deixá-lo de fora foi que o mesmo motorista
 * levando o Fiorino e a Kombi tinha a mesma capacidade nos dois dias.
 *
 * **Não há excluir.** A API tem POST e PATCH e mais nada, de propósito: a van aparece
 * em corridas passadas, e apagar a linha faria o histórico perder a resposta para "em
 * que carro o Thor voltou?". Van vendida se desativa — e some das atribuições novas
 * sem mexer nas antigas.
 */

interface Props {
  vehicles: TaxiVehicleResponse[]
}

const NOVO = { plate: '', label: '', model: '', capacity: '' }

export function FleetEditor({ vehicles }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [erro, setErro] = useState<string | null>(null)
  const [criando, setCriando] = useState(false)
  const [novo, setNovo] = useState(NOVO)
  const [editando, setEditando] = useState<string | null>(null)
  const [rascunho, setRascunho] = useState(NOVO)

  function run(action: () => Promise<{ ok: boolean; message?: string }>, aoFim?: () => void) {
    setErro(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setErro(result.message ?? 'Não foi possível concluir')
        return
      }
      aoFim?.()
      router.refresh()
    })
  }

  function capacidadeDe(raw: string): number | null {
    const valor = Number(raw)
    if (!Number.isInteger(valor) || valor < 1 || valor > 20) return null
    return valor
  }

  function corpo(dados: typeof NOVO): Record<string, unknown> | null {
    const petCapacity = capacidadeDe(dados.capacity)
    if (petCapacity === null) {
      setErro('Quantos pets cabem? Um número de 1 a 20.')
      return null
    }
    return {
      plate: dados.plate.replace(/[^A-Za-z0-9]/g, ''),
      label: dados.label,
      ...(dados.model.trim() ? { model: dados.model.trim() } : {}),
      petCapacity,
    }
  }

  function criar() {
    const payload = corpo(novo)
    if (!payload) return
    run(() => createVehicleAction({ ...payload, active: true }), () => {
      setNovo(NOVO)
      setCriando(false)
    })
  }

  function salvarEdicao(vehicleId: string) {
    const payload = corpo(rascunho)
    if (!payload) return
    run(() => updateVehicleAction(vehicleId, payload), () => setEditando(null))
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-fg">Frota</h2>
        {!criando && (
          <button
            type="button"
            className="btn h-9"
            disabled={pending}
            onClick={() => setCriando(true)}
          >
            Novo veículo
          </button>
        )}
      </div>

      <FormError message={erro} />

      {vehicles.length === 0 && !criando && (
        <p className="text-sm text-subtle">
          Nenhum veículo. A capacidade de cada corrida é a do motorista — o &quot;pets por
          vez&quot; do cadastro dele, em Agenda → Profissionais.
        </p>
      )}

      {vehicles.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {vehicles.map((vehicle) =>
            editando === vehicle.id ? (
              <li key={vehicle.id} className="space-y-2 py-3">
                <div className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr_7rem]">
                  <Field label="Placa" htmlFor={`placa-${vehicle.id}`}>
                    <input
                      id={`placa-${vehicle.id}`}
                      className="field"
                      value={rascunho.plate}
                      onChange={(event) => setRascunho((c) => ({ ...c, plate: event.target.value }))}
                    />
                  </Field>
                  <Field label="Como a equipe chama" htmlFor={`apelido-${vehicle.id}`}>
                    <input
                      id={`apelido-${vehicle.id}`}
                      className="field"
                      value={rascunho.label}
                      onChange={(event) => setRascunho((c) => ({ ...c, label: event.target.value }))}
                    />
                  </Field>
                  <Field label="Modelo" htmlFor={`modelo-${vehicle.id}`}>
                    <input
                      id={`modelo-${vehicle.id}`}
                      className="field"
                      value={rascunho.model}
                      onChange={(event) => setRascunho((c) => ({ ...c, model: event.target.value }))}
                    />
                  </Field>
                  <Field label="Pets" htmlFor={`pets-${vehicle.id}`}>
                    <input
                      id={`pets-${vehicle.id}`}
                      className="field"
                      inputMode="numeric"
                      value={rascunho.capacity}
                      onChange={(event) =>
                        setRascunho((c) => ({ ...c, capacity: event.target.value }))
                      }
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-primary h-9"
                    disabled={pending}
                    onClick={() => salvarEdicao(vehicle.id)}
                  >
                    Salvar
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost h-9"
                    disabled={pending}
                    onClick={() => setEditando(null)}
                  >
                    Cancelar
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={vehicle.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <span className={vehicle.active ? 'text-fg' : 'text-subtle line-through'}>
                  {vehicle.label}
                  <span className="ml-2 text-subtle">
                    {vehicle.plate}
                    {vehicle.model ? ` · ${vehicle.model}` : ''}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-subtle">
                    {vehicle.petCapacity} {vehicle.petCapacity === 1 ? 'pet' : 'pets'}
                  </span>
                  <button
                    type="button"
                    className="text-sm underline decoration-line hover:decoration-fg"
                    disabled={pending}
                    onClick={() => {
                      setEditando(vehicle.id)
                      setRascunho({
                        plate: vehicle.plate,
                        label: vehicle.label,
                        model: vehicle.model ?? '',
                        capacity: String(vehicle.petCapacity),
                      })
                    }}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="text-sm underline decoration-line hover:decoration-fg"
                    disabled={pending}
                    onClick={() =>
                      run(() => updateVehicleAction(vehicle.id, { active: !vehicle.active }))
                    }
                  >
                    {vehicle.active ? 'Desativar' : 'Reativar'}
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      {criando && (
        <div className="space-y-2 rounded-xl border border-line px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr_7rem]">
            <Field label="Placa" htmlFor="novo-placa" hint="ABC1234 ou ABC1D23">
              <input
                id="novo-placa"
                className="field"
                placeholder="ABC1D23"
                value={novo.plate}
                onChange={(event) => setNovo((c) => ({ ...c, plate: event.target.value }))}
              />
            </Field>
            <Field label="Como a equipe chama" htmlFor="novo-apelido">
              <input
                id="novo-apelido"
                className="field"
                placeholder="Van branca"
                value={novo.label}
                onChange={(event) => setNovo((c) => ({ ...c, label: event.target.value }))}
              />
            </Field>
            <Field label="Modelo" htmlFor="novo-modelo">
              <input
                id="novo-modelo"
                className="field"
                placeholder="Fiorino"
                value={novo.model}
                onChange={(event) => setNovo((c) => ({ ...c, model: event.target.value }))}
              />
            </Field>
            <Field label="Pets" htmlFor="novo-pets" hint="Quantos cabem">
              <input
                id="novo-pets"
                className="field"
                inputMode="numeric"
                placeholder="4"
                value={novo.capacity}
                onChange={(event) => setNovo((c) => ({ ...c, capacity: event.target.value }))}
              />
            </Field>
          </div>
          <p className="hint">
            A corrida usa o menor entre este número e o &quot;pets por vez&quot; do
            motorista — quem escolhe é o carro nos dias em que ele é o mais apertado.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary h-9"
              disabled={pending}
              onClick={criar}
            >
              {pending ? 'Criando…' : 'Criar veículo'}
            </button>
            <button
              type="button"
              className="btn btn-ghost h-9"
              disabled={pending}
              onClick={() => {
                setCriando(false)
                setNovo(NOVO)
                setErro(null)
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}
