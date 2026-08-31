'use client'

import { useState, useTransition } from 'react'
import type { DayAppointment, ServiceResponse } from '@petshop/shared-types'
import { Field, FormError } from '@/components/ui'
import { checkOutAction } from '../actions'

/**
 * A janela de conclusão do atendimento.
 *
 * Até esta entrega o botão "Concluir" mandava payload vazio: o backend aceitava peso,
 * observação e serviço extra desde o MOD-AGENDA, e a tela nunca perguntou nada. O
 * resultado era um atendimento fechado sem registro nenhum do que aconteceu — e é
 * exatamente o buraco que o MOD-PRONT-01 veio tapar.
 *
 * Três campos, e nenhum obrigatório. O balcão tem um cliente na frente esperando para
 * ir embora; um formulário que exige preenchimento vira preenchimento inventado, que
 * é pior que campo vazio — porque campo vazio ninguém confunde com informação.
 */
export function CheckoutPanel({
  appointment,
  services,
  onClose,
  onDone,
}: {
  appointment: DayAppointment
  services: ServiceResponse[]
  onClose: () => void
  onDone: () => void
}) {
  const [weight, setWeight] = useState('')
  const [observations, setObservations] = useState('')
  const [extras, setExtras] = useState<string[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startEnvio] = useTransition()

  const jaFeitos = new Set(appointment.services)
  const disponiveis = services.filter((service) => !jaFeitos.has(service.name))

  function confirmar() {
    setErro(null)
    const peso = weight.trim() ? Number(weight.replace(',', '.')) : undefined
    if (peso !== undefined && (Number.isNaN(peso) || peso <= 0)) {
      setErro('Peso inválido — use quilos, como 12,4')
      return
    }

    startEnvio(async () => {
      const result = await checkOutAction(appointment.id, {
        ...(peso === undefined ? {} : { weightKg: peso }),
        ...(observations.trim() ? { observations: observations.trim() } : {}),
        ...(extras.length > 0 ? { extraItems: extras.map((serviceId) => ({ serviceId })) } : {}),
      })
      if (result.ok) onDone()
      else setErro(result.message)
    })
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-line bg-surface px-3 py-3">
      <Field label="Peso de hoje (kg)" htmlFor={`peso-${appointment.id}`} hint="Opcional — entra na série do pet">
        <input
          id={`peso-${appointment.id}`}
          className="field"
          inputMode="decimal"
          placeholder="12,4"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
        />
      </Field>

      <Field
        label="Como foi o atendimento"
        htmlFor={`obs-${appointment.id}`}
        hint="Fica no prontuário do pet e pode ser corrigido por 24h"
      >
        <textarea
          id={`obs-${appointment.id}`}
          className="field min-h-20"
          placeholder="Ficou agitado no secador; não deixou cortar a unha traseira."
          value={observations}
          onChange={(event) => setObservations(event.target.value)}
        />
      </Field>

      {disponiveis.length > 0 && (
        <fieldset>
          <legend className="hint mb-1.5">Serviço acrescentado durante a execução</legend>
          <div className="flex flex-wrap gap-1.5">
            {disponiveis.map((service) => {
              const marcado = extras.includes(service.id)
              return (
                <button
                  key={service.id}
                  type="button"
                  aria-pressed={marcado}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    marcado ? 'border-accent bg-accent/10' : 'border-line'
                  }`}
                  onClick={() =>
                    setExtras((current) =>
                      marcado
                        ? current.filter((id) => id !== service.id)
                        : [...current, service.id],
                    )
                  }
                >
                  {service.name}
                </button>
              )
            })}
          </div>
        </fieldset>
      )}

      <FormError message={erro} />

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={enviando} onClick={confirmar}>
          {enviando ? 'Concluindo…' : 'Concluir atendimento'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={enviando} onClick={onClose}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
