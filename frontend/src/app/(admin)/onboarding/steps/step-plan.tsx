'use client'

import { useState } from 'react'
import {
  PLAN_CATALOG,
  PLAN_ORDER,
  annualDiscountPercentOf,
  formatBRL,
  type Plan,
  type PlanPriceRow,
} from '@petshop/shared-types'
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
 * Nome, teto e destaques saem de `PLAN_CATALOG` — os mesmos da landing page, que é de
 * onde a pessoa chegou com o plano já escolhido. Duas divisões diferentes entre a página
 * que vende e a tela que contrata eram a promessa quebrada no primeiro minuto.
 *
 * **O preço, não.** Ele vem da tabela vigente (`lib/plan-prices.ts`), porque a equipe o
 * muda pelo console e o do catálogo é só o padrão de instalação nova. Os **dois ciclos**
 * aparecem juntos: aqui ainda não se escolhe periodicidade — o teste não cobra nada —, e
 * quem decide pelo valor precisa ver os dois números antes de escolher o plano, não
 * depois.
 */

export function StepPlan({
  pending,
  onSubmit,
  plan,
  prices,
}: StepProps & { plan: Plan; prices: PlanPriceRow[] }) {
  const [selected, setSelected] = useState<Plan>(plan)

  return (
    <Card>
      <h1 className="text-2xl font-semibold sm:text-3xl">Escolha Seu Plano</h1>
      <p className="hint mt-2">
        Você tem 14 dias de teste. Nada é cobrado agora, e dá para trocar de plano depois.
      </p>

      <div className="mt-8 space-y-3" role="radiogroup" aria-label="Planos disponíveis">
        {PLAN_ORDER.map((key) => {
          const option = PLAN_CATALOG[key]
          const limit = option.seats
          const isSelected = selected === option.key
          const tabela = prices.find((linha) => linha.plan === key)
          const mensal = tabela?.monthlyCents ?? option.priceCents
          const anual = tabela?.yearlyCents ?? option.priceYearlyCents
          const desconto =
            mensal !== null && anual !== null ? annualDiscountPercentOf(mensal, anual) : null

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
              <p className="hint mt-1">{option.pitch}</p>
              {/* Os dois ciclos, lado a lado. O ciclo em si é escolhido na hora de pagar,
                  não aqui: o teste não cobra nada. */}
              <p className="mt-2 text-sm font-medium">
                {mensal === null ? (
                  'Sob consulta'
                ) : (
                  <>
                    {formatBRL(mensal)}
                    <span className="text-muted">/mês</span>
                    {anual !== null && (
                      <>
                        <span className="text-muted"> ou </span>
                        {formatBRL(anual)}
                        <span className="text-muted">/ano</span>
                      </>
                    )}
                  </>
                )}
              </p>
              {mensal !== null && anual !== null && (
                <p className="hint mt-0.5">
                  Depois do teste. No anual{desconto !== null ? `, ${desconto}% de desconto —` : ''}{' '}
                  você economiza {formatBRL(mensal * 12 - anual)} no ano.
                </p>
              )}
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
