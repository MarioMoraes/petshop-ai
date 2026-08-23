'use client'

import { useState } from 'react'
import type { Branding } from '@petshop/shared-types'
import { Card, Field } from '@/components/ui'
import { finishOnboardingAction, skipBrandingAction } from '../actions'
import type { StepProps } from '../wizard'

/**
 * Etapa 4 — identidade visual e conclusão.
 *
 * A cor escolhida vale para o portal do tutor e para o site público do
 * estabelecimento (MOD-SITE). Pular é permitido (AC-03): a cor padrão funciona, e
 * prender o onboarding numa escolha estética seria fricção à toa. Tudo o que se
 * escolhe aqui é reeditável depois em `/configuracoes`.
 */

const PRESETS = [
  { color: '#E34A32', name: 'Coral' },
  { color: '#0F766E', name: 'Verde-mar' },
  { color: '#1D4ED8', name: 'Azul' },
  { color: '#7C3AED', name: 'Roxo' },
  { color: '#B45309', name: 'Âmbar' },
  { color: '#171719', name: 'Grafite' },
]

export function StepBranding({
  pending,
  fieldErrors,
  onSubmit,
  branding,
}: StepProps & { branding: Branding }) {
  const [primaryColor, setPrimaryColor] = useState(branding.primaryColor)

  return (
    <Card>
      <h1 className="text-2xl font-semibold sm:text-3xl">
        Quase lá. Escolha a <span className="font-serif italic">sua cor</span>.
      </h1>
      <p className="hint mt-2">
        Ela aparece no portal do tutor e no site do seu petshop. Dá para mudar quando quiser.
      </p>

      <div className="mt-8 space-y-5">
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Cor principal">
          {PRESETS.map((preset) => (
            <button
              key={preset.color}
              type="button"
              role="radio"
              aria-checked={primaryColor.toUpperCase() === preset.color}
              aria-label={preset.name}
              onClick={() => setPrimaryColor(preset.color)}
              className={`h-12 w-12 rounded-full transition ${
                primaryColor.toUpperCase() === preset.color
                  ? 'ring-2 ring-ink ring-offset-2'
                  : 'hover:scale-105'
              }`}
              style={{ backgroundColor: preset.color }}
            />
          ))}
        </div>

        <Field
          label="Ou informe a cor exata"
          htmlFor="primaryColor"
          error={fieldErrors.primaryColor}
          hint="Formato #RRGGBB."
        >
          <div className="flex items-center gap-3">
            <input
              id="primaryColor"
              className="field"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())}
              placeholder="#E34A32"
              maxLength={7}
              aria-invalid={Boolean(fieldErrors.primaryColor)}
            />
            <span
              className="h-11 w-11 shrink-0 rounded-full border border-line"
              style={{ backgroundColor: primaryColor }}
              aria-hidden="true"
            />
          </div>
        </Field>

        {/* Prévia: ver a cor aplicada vale mais do que o código hexadecimal. */}
        <div className="rounded-2xl border border-line p-5">
          <p className="hint mb-3">Prévia</p>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="btn pill px-5 py-2.5 text-sm font-medium text-white"
              style={{ backgroundColor: primaryColor }}
            >
              Agendar banho
            </span>
            <span
              className="pill px-3 py-1 text-xs font-medium"
              style={{ backgroundColor: `${primaryColor}1a`, color: primaryColor }}
            >
              Confirmado
            </span>
          </div>
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={pending}
          onClick={() => onSubmit(() => finishOnboardingAction({ primaryColor }))}
        >
          {pending ? 'Concluindo…' : 'Concluir configuração'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending}
          onClick={() => onSubmit(skipBrandingAction)}
        >
          Pular por enquanto
        </button>
      </div>
    </Card>
  )
}
