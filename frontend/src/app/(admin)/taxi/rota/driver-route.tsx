'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { TaxiRoute, TaxiRouteStop } from '@petshop/shared-types'
import { Badge, Card } from '@/components/ui'
import { advanceRideAction, failRideAction } from '../actions'

/**
 * A rota, parada por parada.
 *
 * Feita para ser usada de pé, com uma das mãos ocupada: um botão principal por
 * parada, grande, e o resto atrás de um toque. O que fica sempre visível é o que
 * decide a próxima ação — hora, endereço, como entrar e se o pet morde.
 *
 * A parada travada (a volta antes do fim do atendimento) aparece esmaecida e **não
 * some**: o motorista precisa saber que ela existe para planejar a tarde (AC-03).
 */

interface Props {
  route: TaxiRoute
}

const NEXT_STEP: Record<string, { to: string; label: string } | null> = {
  ASSIGNED: { to: 'EN_ROUTE', label: 'Saí' },
  EN_ROUTE: { to: 'ARRIVED', label: 'Cheguei' },
  ARRIVED: { to: 'ONBOARD', label: 'Peguei o pet' },
  ONBOARD: { to: 'DELIVERED', label: 'Entreguei' },
}

const FAILURE_REASONS = [
  { value: 'NO_ONE_HOME', label: 'Ninguém atendeu' },
  { value: 'WRONG_ADDRESS', label: 'Endereço errado' },
  { value: 'PET_REFUSED', label: 'O pet não embarcou' },
  { value: 'NO_SPACE', label: 'Sem espaço na van' },
  { value: 'VEHICLE_ISSUE', label: 'Problema no veículo' },
  { value: 'OTHER', label: 'Outro motivo' },
] as const

function hourOf(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  })
}

export function DriverRoute({ route }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [falhando, setFalhando] = useState<string | null>(null)

  function act(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setError(result.message ?? 'Não foi possível concluir')
        return
      }
      router.refresh()
    })
  }

  function Stop({ stop, index }: { stop: TaxiRouteStop; index: number }) {
    const proximo = NEXT_STEP[stop.status] ?? null
    const encerrada = ['DELIVERED', 'FAILED', 'CANCELLED'].includes(stop.status)

    return (
      <Card className={`space-y-4 ${stop.waitingForAttendance || encerrada ? 'opacity-60' : ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-medium text-fg">
                {hourOf(stop.windowStartsAt, route.timezone)}–{hourOf(stop.windowEndsAt, route.timezone)}
              </span>
              <Badge tone={stop.leg === 'PICKUP' ? 'accent' : 'neutral'}>{stop.legLabel}</Badge>
              <Badge tone={encerrada ? 'success' : 'neutral'}>{stop.statusLabel}</Badge>
            </div>
            <p className="mt-1 truncate text-base font-medium text-fg">
              {stop.petName} · {stop.tutorName}
            </p>
          </div>
          <span className="shrink-0 text-sm text-subtle">#{index + 1}</span>
        </div>

        {/* O que o motorista precisa antes de abrir a porta da van (RN-08). */}
        {(stop.requiresMuzzle || stop.requiresTwoHandlers || stop.alerts.length > 0) && (
          <div className="space-y-1 rounded-md bg-danger/10 p-3">
            {stop.requiresMuzzle && (
              <p className="text-sm font-medium text-danger">Exige focinheira</p>
            )}
            {stop.requiresTwoHandlers && (
              <p className="text-sm font-medium text-danger">Exige duas pessoas</p>
            )}
            {stop.alerts.map((alert) => (
              <p key={`${alert.kind}-${alert.label}`} className="text-sm text-fg">
                {alert.kind === 'MEDICAL' ? '⚕' : '⚠'} {alert.label}
              </p>
            ))}
          </div>
        )}

        <div className="space-y-1 text-sm">
          <p className="text-fg">
            {stop.address.street}, {stop.address.number}
            {stop.address.complement ? ` · ${stop.address.complement}` : ''}
          </p>
          <p className="text-subtle">
            {stop.address.district} — {stop.address.city}/{stop.address.state} · {stop.address.zipCode}
          </p>
          {stop.address.accessNotes && <p className="text-fg">🔑 {stop.address.accessNotes}</p>}
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Abre o mapa e o discador do próprio celular: é o que resolve
              "cheguei e ninguém atende" sem voltar de mãos vazias. */}
          <a
            className="btn h-10"
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              `${stop.address.street}, ${stop.address.number}, ${stop.address.district}, ${stop.address.city}`,
            )}`}
            target="_blank"
            rel="noreferrer"
          >
            Abrir no mapa
          </a>
          {stop.tutorPhone && (
            <a className="btn h-10" href={`tel:${stop.tutorPhone}`}>
              Ligar para {stop.tutorName.split(' ')[0]}
            </a>
          )}
        </div>

        {stop.waitingForAttendance ? (
          <p className="text-sm text-subtle">Aguardando o atendimento terminar</p>
        ) : (
          proximo && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary h-11 flex-1"
                disabled={pending}
                onClick={() => act(() => advanceRideAction(stop.id, { to: proximo.to }))}
              >
                {proximo.label}
              </button>
              {['EN_ROUTE', 'ARRIVED', 'ONBOARD'].includes(stop.status) && (
                <button
                  type="button"
                  className="btn h-11"
                  disabled={pending}
                  onClick={() => setFalhando(falhando === stop.id ? null : stop.id)}
                >
                  Não deu certo
                </button>
              )}
            </div>
          )
        )}

        {falhando === stop.id && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {FAILURE_REASONS.map((reason) => (
              <button
                key={reason.value}
                type="button"
                className="btn h-10 text-sm"
                disabled={pending}
                onClick={() => {
                  setFalhando(null)
                  act(() => failRideAction(stop.id, { reason: reason.value }))
                }}
              >
                {reason.label}
              </button>
            ))}
          </div>
        )}
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-danger/40">
          <p className="text-sm text-danger">{error}</p>
        </Card>
      )}
      {route.stops.map((stop, index) => (
        <Stop key={stop.id} stop={stop} index={index} />
      ))}
    </div>
  )
}
