'use client'

import { useState } from 'react'
import { WEEKDAYS, WEEKDAY_LABELS, type BusinessHours, type Weekday } from '@petshop/shared-types'
import { Card, Field } from '@/components/ui'
import { saveStep3Action } from '../actions'
import type { StepProps } from '../wizard'

/**
 * Etapa 3 — configuração operacional.
 *
 * Horário de funcionamento e as políticas que a agenda vai respeitar. A validação de
 * `closesAt > opensAt` acontece nos dois lados: aqui, para o usuário ver o problema
 * na hora, e no servidor (AC-02), que é quem de fato decide.
 *
 * TODO(MOD-AGENDA): o AC-01 inclui serviços e profissionais nesta etapa; as tabelas
 * são de MOD-AGENDA e ainda não existem.
 */

const TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Cuiaba',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Rio_Branco',
  'America/Noronha',
]

interface Props extends StepProps {
  businessHours: BusinessHours
  timezone: string
  cancellationWindowHours: number
  minBookingNoticeHours: number
  noShowFeePercent: number
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

export function StepBusinessHours(props: Props) {
  const [hours, setHours] = useState<BusinessHours>(props.businessHours)
  const [timezone, setTimezone] = useState(props.timezone)
  const [cancellation, setCancellation] = useState(props.cancellationWindowHours)
  const [notice, setNotice] = useState(props.minBookingNoticeHours)
  const [noShowFee, setNoShowFee] = useState(props.noShowFeePercent)

  const invalidDays = WEEKDAYS.filter((day) => {
    const value = hours[day]
    return !value.closed && toMinutes(value.closesAt) <= toMinutes(value.opensAt)
  })

  function updateDay(day: Weekday, patch: Partial<BusinessHours[Weekday]>) {
    setHours((current) => ({ ...current, [day]: { ...current[day], ...patch } }))
  }

  return (
    <Card>
      <h1 className="text-2xl font-semibold sm:text-3xl">Como seu petshop funciona</h1>
      <p className="hint mt-2">
        A agenda usa esses horários para oferecer os encaixes disponíveis aos tutores.
      </p>

      <div className="mt-8 space-y-5">
        <Field label="Fuso horário" htmlFor="timezone" error={props.fieldErrors.timezone}>
          <select
            id="timezone"
            className="field"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace('America/', '').replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>

        <fieldset>
          <legend className="label">Horário de funcionamento</legend>
          <div className="space-y-2">
            {WEEKDAYS.map((day) => {
              const value = hours[day]
              const invalid = invalidDays.includes(day)

              return (
                <div
                  key={day}
                  className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3"
                >
                  <label className="flex w-32 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!value.closed}
                      onChange={(event) => updateDay(day, { closed: !event.target.checked })}
                      aria-label={`Abrir ${WEEKDAY_LABELS[day]}`}
                    />
                    <span className={value.closed ? 'text-subtle' : 'font-medium'}>
                      {WEEKDAY_LABELS[day]}
                    </span>
                  </label>

                  {value.closed ? (
                    <span className="hint">Fechado</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        className="field w-32"
                        value={value.opensAt}
                        onChange={(event) => updateDay(day, { opensAt: event.target.value })}
                        aria-label={`Abertura ${WEEKDAY_LABELS[day]}`}
                        aria-invalid={invalid}
                      />
                      <span className="hint">às</span>
                      <input
                        type="time"
                        className="field w-32"
                        value={value.closesAt}
                        onChange={(event) => updateDay(day, { closesAt: event.target.value })}
                        aria-label={`Fechamento ${WEEKDAY_LABELS[day]}`}
                        aria-invalid={invalid}
                      />
                    </div>
                  )}

                  {invalid && (
                    <p className="error-text w-full" role="alert">
                      Horário de fechamento deve ser posterior ao de abertura
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Cancelamento sem custo até"
            htmlFor="cancellation"
            error={props.fieldErrors.cancellationWindowHours}
            hint="Abaixo disso conta como falta."
          >
            <div className="flex items-center gap-2">
              <input
                id="cancellation"
                type="number"
                className="field"
                min={0}
                max={72}
                value={cancellation}
                onChange={(event) => setCancellation(Number(event.target.value))}
              />
              <span className="hint">horas antes</span>
            </div>
          </Field>

          <Field
            label="Antecedência mínima"
            htmlFor="notice"
            error={props.fieldErrors.minBookingNoticeHours}
            hint="Para o tutor agendar pelo portal."
          >
            <div className="flex items-center gap-2">
              <input
                id="notice"
                type="number"
                className="field"
                min={0}
                max={168}
                value={notice}
                onChange={(event) => setNotice(Number(event.target.value))}
              />
              <span className="hint">horas</span>
            </div>
          </Field>
        </div>

        <Field
          label="Cobrança por falta"
          htmlFor="noShowFee"
          error={props.fieldErrors.noShowFeePercent}
          hint="Percentual do serviço lançado na conta em caso de falta. Zero desliga a cobrança."
        >
          <div className="flex items-center gap-2">
            <input
              id="noShowFee"
              type="number"
              className="field"
              min={0}
              max={100}
              value={noShowFee}
              onChange={(event) => setNoShowFee(Number(event.target.value))}
            />
            <span className="hint">%</span>
          </div>
        </Field>
      </div>

      <div className="mt-8 flex justify-end">
        <button
          type="button"
          className="btn btn-primary"
          disabled={props.pending || invalidDays.length > 0}
          onClick={() =>
            props.onSubmit(() =>
              saveStep3Action({
                timezone,
                businessHours: hours,
                cancellationWindowHours: cancellation,
                minBookingNoticeHours: notice,
                noShowFeePercent: noShowFee,
              }),
            )
          }
        >
          {props.pending ? 'Salvando…' : 'Continuar'}
        </button>
      </div>
    </Card>
  )
}
