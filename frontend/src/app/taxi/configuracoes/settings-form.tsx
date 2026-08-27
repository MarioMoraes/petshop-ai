'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { ServiceResponse, TaxiSettings, TaxiZoneResponse } from '@petshop/shared-types'
import { Card, Field, FormError } from '@/components/ui'
import { updateTaxiSettingsAction } from '../actions'

/**
 * Configuração do módulo.
 *
 * Cada bloco salva sozinho, como em `/configuracoes`: um "salvar tudo" faria o admin
 * que só queria mudar o preço padrão reenviar também o serviço de cobrança, e um erro
 * em qualquer campo derrubaria a edição inteira.
 *
 * O aviso sobre o serviço de catálogo é a primeira coisa da tela porque é a única
 * coisa **obrigatória** para ligar: o backend recusa `enabled: true` sem ele, e
 * descobrir isso só ao apertar o botão é frustrante sem necessidade.
 */

interface Props {
  settings: TaxiSettings
  zones: TaxiZoneResponse[]
  /** Serviços ativos de categoria `TAXI` — os únicos que podem ancorar a cobrança. */
  taxiServices: ServiceResponse[]
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function TaxiSettingsForm({ settings, zones, taxiServices }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  function save(input: Record<string, unknown>, blockName: string) {
    setError(null)
    setSaved(null)
    startTransition(async () => {
      const result = await updateTaxiSettingsAction(input)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setSaved(blockName)
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <FormError message={error} />
      {saved && <p className="text-sm text-success">{saved} salvo.</p>}

      {taxiServices.length === 0 && (
        <Card className="border-danger/40">
          <h2 className="font-medium text-fg">Falta o serviço de cobrança</h2>
          <p className="mt-1 text-sm text-subtle">
            A corrida é cobrada como um item do agendamento. Crie um serviço da categoria
            &quot;Taxi Dog&quot; em Agenda → Serviços antes de ligar o módulo.
          </p>
        </Card>
      )}

      <Card className="space-y-4">
        <h2 className="font-medium text-fg">Como a corrida é cobrada</h2>
        <Field label="Serviço de catálogo" htmlFor="taxiServiceId">
          <select
            id="taxiServiceId"
            className="input"
            defaultValue={settings.taxiServiceId ?? ''}
            disabled={pending || taxiServices.length === 0}
            onChange={(event) => save({ taxiServiceId: event.target.value }, 'Serviço')}
          >
            <option value="" disabled>
              Escolher serviço
            </option>
            {taxiServices.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            defaultChecked={settings.enabled}
            disabled={pending || (!settings.taxiServiceId && taxiServices.length === 0)}
            onChange={(event) => save({ enabled: event.target.checked }, 'Leva-e-traz')}
          />
          <span className="text-fg">Oferecer leva-e-traz</span>
        </label>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium text-fg">Preço</h2>
        <Field
          label="Preço padrão por perna"
          htmlFor="defaultPriceCents"
          hint="Usado quando o CEP não cai em nenhuma zona."
        >
          <input
            id="defaultPriceCents"
            type="number"
            min={0}
            step={1}
            className="input"
            defaultValue={(settings.defaultPriceCents / 100).toFixed(2)}
            disabled={pending}
            onBlur={(event) =>
              save(
                { defaultPriceCents: Math.round(Number(event.target.value) * 100) },
                'Preço padrão',
              )
            }
          />
        </Field>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            defaultChecked={settings.blockOutsideZones}
            disabled={pending}
            onChange={(event) => save({ blockOutsideZones: event.target.checked }, 'Área atendida')}
          />
          <span>
            <span className="text-fg">Recusar CEP fora das zonas</span>
            <span className="block text-subtle">
              Para quem não atende a cidade inteira. Desligado, o CEP sem zona usa o preço padrão.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            defaultChecked={settings.chargeFailedPickup}
            disabled={pending}
            onChange={(event) => save({ chargeFailedPickup: event.target.checked }, 'Cobrança')}
          />
          <span>
            <span className="text-fg">Cobrar quando ninguém atender</span>
            <span className="block text-subtle">
              Desligado por padrão: a corrida frustrada sai da conta do tutor.
            </span>
          </span>
        </label>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium text-fg">Janela e alertas</h2>
        <Field
          label="Largura padrão da janela (minutos)"
          htmlFor="defaultWindowMinutes"
          hint="A promessa feita ao tutor: “passo entre 8h e 9h”."
        >
          <input
            id="defaultWindowMinutes"
            type="number"
            min={15}
            max={240}
            step={15}
            className="input"
            defaultValue={settings.defaultWindowMinutes}
            disabled={pending}
            onBlur={(event) =>
              save({ defaultWindowMinutes: Number(event.target.value) }, 'Janela padrão')
            }
          />
        </Field>

        <Field
          label="Avisar sobre corrida sem motorista (horas antes)"
          htmlFor="unassignedAlertHours"
        >
          <input
            id="unassignedAlertHours"
            type="number"
            min={1}
            max={72}
            className="input"
            defaultValue={settings.unassignedAlertHours}
            disabled={pending}
            onBlur={(event) =>
              save({ unassignedAlertHours: Number(event.target.value) }, 'Alerta')
            }
          />
        </Field>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium text-fg">Zonas de preço</h2>
        {zones.length === 0 ? (
          <p className="text-sm text-subtle">
            Nenhuma zona. Todas as corridas usam o preço padrão de {money(settings.defaultPriceCents)}.
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {zones.map((zone) => (
              <li key={zone.id} className="flex items-center justify-between py-2">
                <span className="text-fg">
                  {zone.name}
                  <span className="ml-2 text-subtle">{zone.zipPrefixes.join(', ')}</span>
                </span>
                <span className="text-subtle">{money(zone.priceCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
