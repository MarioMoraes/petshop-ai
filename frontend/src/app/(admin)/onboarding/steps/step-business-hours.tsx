'use client'

import { useState } from 'react'
import { WEEKDAYS, WEEKDAY_LABELS, type BusinessHours, type Weekday } from '@petshop/shared-types'
import { Button, Card, Field } from '@/components/ui'
import { saveStep3Action } from '../actions'
import type { StepProps } from '../wizard'

/**
 * Etapa 3 — configuração operacional.
 *
 * Horário de funcionamento, as políticas que a agenda vai respeitar e quem atende. A
 * validação de `closesAt > opensAt` acontece nos dois lados: aqui, para o usuário ver
 * o problema na hora, e no servidor (AC-02), que é quem de fato decide.
 *
 * O AC-01 pede serviços **e** profissionais nesta etapa. Os serviços não são
 * perguntados: eles já vieram semeados no provisionamento, com preço de referência
 * por porte, e revisar preço dentro de um wizard é pior do que fazê-lo na tela de
 * serviços, com calma. O que se pergunta é o que o sistema não consegue adivinhar —
 * nome de gente.
 *
 * A jornada de cada pessoa também não é perguntada: nasce igual ao horário de
 * funcionamento definido logo acima. Quem trabalha em horário diferente é a exceção,
 * e a exceção se ajusta depois.
 */

/** Os papéis que executam atendimento (`PROFESSIONAL_ROLE_KEYS` do RBAC). */
const PROFESSIONAL_ROLES = [
  { key: 'BATHER', label: 'Banhista' },
  { key: 'GROOMER', label: 'Tosador' },
  { key: 'VET', label: 'Veterinário' },
  { key: 'DRIVER', label: 'Motorista' },
] as const

type ProfessionalRole = (typeof PROFESSIONAL_ROLES)[number]['key']

interface ProfessionalDraft {
  /** Só para a chave do React: a lista é reordenável por remoção. */
  key: string
  displayName: string
  roleKey: ProfessionalRole
  maxConcurrentPets: number
}

function emptyProfessional(): ProfessionalDraft {
  return {
    key: crypto.randomUUID(),
    displayName: '',
    roleKey: 'BATHER',
    maxConcurrentPets: 1,
  }
}

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
  const [team, setTeam] = useState<ProfessionalDraft[]>([emptyProfessional()])

  // Linha em branco não é erro: é a linha que o formulário já oferece preenchida por
  // ninguém. Só o que tem nome viaja.
  const filledTeam = team.filter((person) => person.displayName.trim().length > 0)
  const shortNames = filledTeam.filter((person) => person.displayName.trim().length < 2)

  const invalidDays = WEEKDAYS.filter((day) => {
    const value = hours[day]
    return !value.closed && toMinutes(value.closesAt) <= toMinutes(value.opensAt)
  })

  function updateDay(day: Weekday, patch: Partial<BusinessHours[Weekday]>) {
    setHours((current) => ({ ...current, [day]: { ...current[day], ...patch } }))
  }

  function updatePerson(key: string, patch: Partial<ProfessionalDraft>) {
    setTeam((current) =>
      current.map((person) => (person.key === key ? { ...person, ...patch } : person)),
    )
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
                      className="check"
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

        <fieldset>
          <legend className="label">Quem atende</legend>
          <p className="hint mb-3">
            Cada pessoa entra com a jornada do estabelecimento e habilitada em todos os serviços. Dá
            para ajustar depois em Profissionais.
          </p>

          <div className="space-y-2">
            {team.map((person) => (
              <div
                key={person.key}
                className="flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-card px-4 py-3"
              >
                <div className="min-w-[12rem] flex-1">
                  <label className="label text-xs" htmlFor={`nome-${person.key}`}>
                    Nome
                  </label>
                  <input
                    id={`nome-${person.key}`}
                    className="field"
                    placeholder="Ana"
                    maxLength={60}
                    value={person.displayName}
                    onChange={(event) =>
                      updatePerson(person.key, { displayName: event.target.value })
                    }
                  />
                </div>

                <div className="w-40">
                  <label className="label text-xs" htmlFor={`papel-${person.key}`}>
                    Função
                  </label>
                  <select
                    id={`papel-${person.key}`}
                    className="field"
                    value={person.roleKey}
                    onChange={(event) =>
                      updatePerson(person.key, { roleKey: event.target.value as ProfessionalRole })
                    }
                  >
                    {PROFESSIONAL_ROLES.map((role) => (
                      <option key={role.key} value={role.key}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="w-36">
                  <label className="label text-xs" htmlFor={`capacidade-${person.key}`}>
                    Pets por vez
                  </label>
                  <input
                    id={`capacidade-${person.key}`}
                    type="number"
                    className="field"
                    min={1}
                    max={20}
                    value={person.maxConcurrentPets}
                    onChange={(event) =>
                      updatePerson(person.key, {
                        maxConcurrentPets: Math.max(1, Number(event.target.value) || 1),
                      })
                    }
                  />
                </div>

                {team.length > 1 && (
                  <Button
                    type="button"
                    onClick={() =>
                      setTeam((current) => current.filter((item) => item.key !== person.key))
                    }
                    aria-label={`Remover ${person.displayName || 'esta pessoa'}`}
                  >
                    Remover
                  </Button>
                )}
              </div>
            ))}
          </div>

          <Button
            type="button"
            className="mt-3"
            disabled={team.length >= 30}
            onClick={() => setTeam((current) => [...current, emptyProfessional()])}
          >
            Adicionar pessoa
          </Button>

          <p className="hint mt-2">
            {filledTeam.length === 0
              ? 'Você pode seguir sem cadastrar ninguém agora e fazer isso mais tarde.'
              : `Pets por vez é quantos atendimentos a pessoa toca ao mesmo tempo — o banhista lava um, põe para secar e começa o próximo.`}
          </p>
        </fieldset>
      </div>

      <div className="mt-8 flex justify-end">
        <Button
          type="button"
          busy={props.pending}
          disabled={invalidDays.length > 0 || shortNames.length > 0}
          onClick={() =>
            props.onSubmit(() =>
              saveStep3Action({
                timezone,
                businessHours: hours,
                cancellationWindowHours: cancellation,
                minBookingNoticeHours: notice,
                noShowFeePercent: noShowFee,
                professionals: filledTeam.map((person) => ({
                  displayName: person.displayName.trim(),
                  roleKey: person.roleKey,
                  maxConcurrentPets: person.maxConcurrentPets,
                })),
              }),
            )
          }
          busyLabel="Salvando…"
        >
          Continuar
        </Button>
      </div>
    </Card>
  )
}
