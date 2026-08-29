'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type {
  AvailableTaxiDriver,
  TaxiBoard as TaxiBoardData,
  TaxiRideResponse,
  TaxiVehicleResponse,
} from '@petshop/shared-types'
import { Badge, Card, EmptyState } from '@/components/ui'
import { advanceRideAction, assignRideAction, cancelRideAction, failRideAction } from './actions'

/**
 * O painel do dia do Taxi Dog.
 *
 * A **fila sem dono fica no topo**, e não misturada às faixas dos motoristas: uma
 * corrida sem motorista é um pet que vai esperar na calçada, e é a única coisa desta
 * tela que exige ação antes do fim do dia.
 *
 * As corridas encerradas ficam num bloco recolhido no fim. Elas não somem porque
 * "quantas rodaram hoje" é a pergunta do fechamento — mas também não disputam espaço
 * com o que ainda precisa acontecer.
 */

interface Props {
  board: TaxiBoardData
  drivers: { id: string; displayName: string }[]
  /**
   * Vans ativas. A capacidade da corrida é `min(motorista, veículo)`, e sem frota
   * cadastrada o seletor não aparece — vale só o número do motorista.
   */
  vehicles: TaxiVehicleResponse[]
  /** `taxi:configure`: preço manual e configuração. Não gate de operação. */
  canConfigure: boolean
}

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'danger'> = {
  REQUESTED: 'danger',
  ASSIGNED: 'neutral',
  EN_ROUTE: 'accent',
  ARRIVED: 'accent',
  ONBOARD: 'accent',
  DELIVERED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
}

/** O botão que avança a corrida, por status atual. Nulo = nada a fazer aqui. */
const NEXT_STEP: Record<string, { to: string; label: string } | null> = {
  ASSIGNED: { to: 'EN_ROUTE', label: 'Saiu' },
  EN_ROUTE: { to: 'ARRIVED', label: 'Chegou' },
  ARRIVED: { to: 'ONBOARD', label: 'Pegou o pet' },
  ONBOARD: { to: 'DELIVERED', label: 'Entregou' },
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

function money(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function shiftDay(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

export function TaxiBoard({ board, drivers, vehicles, canConfigure }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<AvailableTaxiDriver[] | null>(null)
  const [falhando, setFalhando] = useState<string | null>(null)
  const [mostrarEncerradas, setMostrarEncerradas] = useState(false)

  function act(action: () => Promise<{ ok: boolean; message?: string; available?: AvailableTaxiDriver[] }>) {
    setError(null)
    setSuggestions(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setError(result.message ?? 'Não foi possível concluir')
        // A alternativa vem junto da recusa: quem está atribuindo precisa saber quem
        // **pode** ir, não só que este não pode.
        setSuggestions(result.available ?? null)
        return
      }
      router.refresh()
    })
  }

  const now = Date.now()

  function RideCard({ ride, showDriver }: { ride: TaxiRideResponse; showDriver?: boolean }) {
    const atrasada =
      new Date(ride.windowEndsAt).getTime() < now &&
      !['DELIVERED', 'FAILED', 'CANCELLED'].includes(ride.status)
    const travada = ride.leg === 'DROPOFF' && ride.readyAt === null
    const proximo = NEXT_STEP[ride.status] ?? null

    return (
      <Card className={`space-y-3 ${travada ? 'opacity-60' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-fg">
                {hourOf(ride.windowStartsAt, board.timezone)}–{hourOf(ride.windowEndsAt, board.timezone)}
              </span>
              <Badge tone={ride.leg === 'PICKUP' ? 'accent' : 'neutral'}>{ride.legLabel}</Badge>
              <Badge tone={STATUS_TONE[ride.status] ?? 'neutral'}>{ride.statusLabel}</Badge>
              {atrasada && <Badge tone="danger">Atrasada</Badge>}
            </div>
            <p className="mt-1 text-sm text-subtle">
              {ride.address.street}, {ride.address.number}
              {ride.address.complement ? ` · ${ride.address.complement}` : ''} — {ride.address.district}
            </p>
            {ride.address.accessNotes && (
              // A instrução de acesso decide entre entregar e voltar de mãos vazias.
              <p className="mt-1 text-sm text-fg">🔑 {ride.address.accessNotes}</p>
            )}
            {travada && (
              <p className="mt-1 text-sm text-subtle">Aguardando o atendimento terminar</p>
            )}
          </div>
          {canConfigure && <span className="text-sm text-subtle">{money(ride.priceCents)}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            `assignRide` grava `vehicleId: input.vehicleId ?? null` — trocar o motorista
            sem reenviar a van a **apagaria**. Por isso os dois seletores mandam sempre
            o par completo, e não só o campo que mudou.
          */}
          {showDriver && (
            <select
              className="field h-9 text-sm"
              value={ride.driverId ?? ''}
              disabled={pending}
              onChange={(event) =>
                act(() =>
                  assignRideAction(ride.id, {
                    driverId: event.target.value,
                    vehicleId: ride.vehicleId,
                  }),
                )
              }
              aria-label="Motorista"
            >
              <option value="" disabled>
                Escolher motorista
              </option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.displayName}
                </option>
              ))}
            </select>
          )}

          {/*
            A van só aparece depois que há motorista: `POST /assign` exige `driverId`, e
            oferecer o carro antes seria um seletor que não tem como salvar.
          */}
          {showDriver && ride.driverId && vehicles.length > 0 && (
            <select
              className="field h-9 text-sm"
              value={ride.vehicleId ?? ''}
              disabled={pending}
              onChange={(event) =>
                act(() =>
                  assignRideAction(ride.id, {
                    driverId: ride.driverId,
                    vehicleId: event.target.value || null,
                  }),
                )
              }
              aria-label="Veículo"
            >
              <option value="">Sem veículo definido</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label} · {vehicle.petCapacity}
                </option>
              ))}
            </select>
          )}

          {proximo && !travada && (
            <button
              type="button"
              className="btn btn-primary h-9"
              disabled={pending}
              onClick={() => act(() => advanceRideAction(ride.id, { to: proximo.to }))}
            >
              {proximo.label}
            </button>
          )}

          {['EN_ROUTE', 'ARRIVED', 'ONBOARD'].includes(ride.status) && (
            <button
              type="button"
              className="btn h-9"
              disabled={pending}
              onClick={() => setFalhando(falhando === ride.id ? null : ride.id)}
            >
              Não deu certo
            </button>
          )}

          {['REQUESTED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(ride.status) && (
            <button
              type="button"
              className="btn h-9 text-danger"
              disabled={pending}
              onClick={() => act(() => cancelRideAction(ride.id, { reason: 'TUTOR_REQUEST' }))}
            >
              Cancelar
            </button>
          )}
        </div>

        {falhando === ride.id && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {FAILURE_REASONS.map((reason) => (
              <button
                key={reason.value}
                type="button"
                className="btn h-8 text-sm"
                disabled={pending}
                onClick={() => {
                  setFalhando(null)
                  act(() => failRideAction(ride.id, { reason: reason.value }))
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button type="button" className="btn h-9" onClick={() => router.push(`/taxi?date=${shiftDay(board.date, -1)}`)}>
            ← Ontem
          </button>
          <button type="button" className="btn h-9" onClick={() => router.push(`/taxi?date=${shiftDay(board.date, 1)}`)}>
            Amanhã →
          </button>
        </div>
        <div className="flex gap-3 text-sm text-subtle">
          <span>{board.totals.rides} corridas</span>
          {board.totals.overdue > 0 && (
            <span className="text-danger">{board.totals.overdue} atrasadas</span>
          )}
          <span>{board.totals.delivered} entregues</span>
        </div>
      </div>

      {error && (
        <Card className="border-danger/40">
          <p className="text-sm text-danger">{error}</p>
          {suggestions && suggestions.length > 0 && (
            <p className="mt-2 text-sm text-subtle">
              Disponíveis nessa janela:{' '}
              {suggestions.map((driver) => `${driver.displayName} (cabem ${driver.remaining})`).join(', ')}
            </p>
          )}
        </Card>
      )}

      {board.totals.rides === 0 ? (
        <EmptyState
          title="Nenhuma corrida neste dia"
          description="O leva-e-traz é pedido a partir de um agendamento, na Agenda."
        />
      ) : (
        <>
          {board.unassigned.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-danger">
                Sem motorista ({board.unassigned.length})
              </h2>
              {board.unassigned.map((ride) => (
                <RideCard key={ride.id} ride={ride} showDriver />
              ))}
            </section>
          )}

          {board.lanes.map((lane) => (
            <section key={lane.driverId} className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
                {lane.displayName}
                <span className="text-subtle">({lane.rides.length})</span>
                {lane.overdue > 0 && <Badge tone="danger">{lane.overdue} atrasada(s)</Badge>}
              </h2>
              {lane.rides.map((ride) => (
                <RideCard key={ride.id} ride={ride} showDriver />
              ))}
            </section>
          ))}

          {board.closed.length > 0 && (
            <section className="space-y-3">
              <button
                type="button"
                className="text-sm text-subtle hover:text-fg"
                onClick={() => setMostrarEncerradas((value) => !value)}
              >
                {mostrarEncerradas ? '▾' : '▸'} Encerradas ({board.closed.length})
              </button>
              {mostrarEncerradas &&
                board.closed.map((ride) => <RideCard key={ride.id} ride={ride} />)}
            </section>
          )}
        </>
      )}
    </div>
  )
}
