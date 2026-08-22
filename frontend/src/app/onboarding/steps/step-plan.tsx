'use client'

import { useState } from 'react'
import { PLAN_SEAT_LIMITS, type Plan } from '@petshop/shared-types'
import { Badge, Card } from '@/components/ui'
import { saveStep2Action } from '../actions'
import type { StepProps } from '../wizard'

/**
 * Etapa 2 — plano.
 *
 * Escolher plano no trial não cobra nada: define o teto de usuários (RN-11) e o que
 * fica disponível. A troca continua possível a qualquer momento, e dizer isso aqui
 * tira o peso da decisão.
 */

const PLANS: Array<{ key: Plan; name: string; pitch: string; highlights: string[] }> = [
  {
    key: 'STARTER',
    name: 'Starter',
    pitch: 'Para quem está começando a organizar a operação.',
    highlights: ['Agenda e prontuário', 'Portal do tutor', 'Site do estabelecimento'],
  },
  {
    key: 'PRO',
    name: 'Pro',
    pitch: 'Para equipes que já vivem dentro do sistema.',
    highlights: ['Tudo do Starter', 'Taxi Dog e campanhas', 'Relatórios da operação'],
  },
  {
    key: 'ENTERPRISE',
    name: 'Enterprise',
    pitch: 'Para redes com várias unidades.',
    highlights: ['Tudo do Pro', 'Usuários ilimitados', 'Suporte dedicado'],
  },
]

export function StepPlan({ pending, onSubmit, plan }: StepProps & { plan: Plan }) {
  const [selected, setSelected] = useState<Plan>(plan)

  return (
    <Card>
      <h1 className="text-2xl font-semibold sm:text-3xl">Escolha seu plano</h1>
      <p className="hint mt-2">
        Você tem 14 dias de teste. Nada é cobrado agora, e dá para trocar de plano depois.
      </p>

      <div className="mt-8 space-y-3" role="radiogroup" aria-label="Planos disponíveis">
        {PLANS.map((option) => {
          const limit = PLAN_SEAT_LIMITS[option.key]
          const isSelected = selected === option.key

          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(option.key)}
              className={`w-full rounded-2xl border p-5 text-left transition ${
                isSelected
                  ? 'border-shell bg-black/[0.03]'
                  : 'border-line hover:border-subtle'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-lg font-semibold">{option.name}</span>
                <Badge tone={isSelected ? 'accent' : 'neutral'}>
                  {limit === null ? 'Usuários ilimitados' : `Até ${limit} usuários`}
                </Badge>
              </div>
              <p className="hint mt-1">{option.pitch}</p>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                {option.highlights.map((highlight) => (
                  <li key={highlight}>· {highlight}</li>
                ))}
              </ul>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className="btn btn-primary mt-8 w-full"
        disabled={pending}
        onClick={() => onSubmit(() => saveStep2Action(selected))}
      >
        {pending ? 'Salvando…' : 'Continuar'}
      </button>
    </Card>
  )
}
