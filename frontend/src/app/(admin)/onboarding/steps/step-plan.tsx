'use client'

import { useState } from 'react'
import { PLAN_CATALOG, PLAN_ORDER, formatBRL, type Plan } from '@petshop/shared-types'
import { Badge, Button, Card } from '@/components/ui'
import { saveStep2Action } from '../actions'
import type { StepProps } from '../wizard'

/**
 * Etapa 2 — plano.
 *
 * Escolher plano no trial não cobra nada: define o teto de usuários (RN-11) e o que
 * fica disponível. A troca continua possível a qualquer momento, e dizer isso aqui
 * tira o peso da decisão.
 *
 * Nome, preço, teto e destaques saem de `PLAN_CATALOG` — os mesmos da landing page, que
 * é de onde a pessoa chegou com o plano já escolhido. Duas divisões diferentes entre a
 * página que vende e a tela que contrata eram a promessa quebrada no primeiro minuto.
 */

export function StepPlan({ pending, onSubmit, plan }: StepProps & { plan: Plan }) {
  const [selected, setSelected] = useState<Plan>(plan)

  return (
    <Card>
      <h1 className="text-2xl font-semibold sm:text-3xl">Escolha seu plano</h1>
      <p className="hint mt-2">
        Você tem 14 dias de teste. Nada é cobrado agora, e dá para trocar de plano depois.
      </p>

      <div className="mt-8 space-y-3" role="radiogroup" aria-label="Planos disponíveis">
        {PLAN_ORDER.map((key) => {
          const option = PLAN_CATALOG[key]
          const limit = option.seats
          const isSelected = selected === option.key

          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(option.key)}
              className={`w-full rounded-2xl border p-5 text-left transition ${
                isSelected ? 'border-shell bg-black/[0.03]' : 'border-line hover:border-subtle'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-lg font-semibold">{option.name}</span>
                <Badge tone={isSelected ? 'accent' : 'neutral'}>
                  {limit === null ? 'Usuários ilimitados' : `Até ${limit} usuários`}
                </Badge>
              </div>
              <p className="hint mt-1">
                {option.priceCents === null
                  ? 'Sob consulta'
                  : `${formatBRL(option.priceCents)}/mês depois do teste`}
                {' · '}
                {option.pitch}
              </p>
              <p className="mt-3 text-sm font-medium">{option.includesLead}</p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                {option.includes.map((highlight) => (
                  <li key={highlight}>· {highlight}</li>
                ))}
              </ul>
            </button>
          )
        })}
      </div>

      <div className="mt-8 flex justify-end">
        <Button
          type="button"
          busy={pending}
          onClick={() => onSubmit(() => saveStep2Action(selected))}
          busyLabel="Salvando…"
        >
          Continuar
        </Button>
      </div>
    </Card>
  )
}
