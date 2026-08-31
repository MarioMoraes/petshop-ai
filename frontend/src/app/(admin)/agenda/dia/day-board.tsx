'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { DayView, ServiceResponse, TaxiRideResponse } from '@petshop/shared-types'
import { Badge, Card } from '@/components/ui'
import { checkInAction } from '../actions'
import { CheckoutPanel } from './checkout-panel'
import { TaxiPanel } from './taxi-panel'

/**
 * O painel do dia, uma coluna por profissional.
 *
 * A coluna do ausente **fica**, marcada (AC-02). Some-se ela e a equipe conclui que
 * o sistema perdeu a pessoa — e o suporte recebe uma ligação.
 *
 * A ordenação de alertas é por severidade, e o crítico ganha destaque visual: o
 * cartão é lido de relance por quem já está com o pet na mão, não estudado.
 */

interface Props {
  view: DayView
  date: string
  /** Catálogo ativo, para o serviço acrescentado durante a execução (RN-18). */
  services: ServiceResponse[]
  /**
   * Taxi Dog ligado e configurado, com a janela padrão do módulo. `null` quando o
   * módulo está desligado, quando o serviço não respondeu ou quando quem olha não
   * tem `taxi:operate` — nos três casos o cartão simplesmente não oferece corrida.
   */
  taxi: { windowMinutes: number } | null
  /** Corridas do dia, agrupadas por agendamento. */
  taxiRides: Record<string, TaxiRideResponse[]>
}

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  CONFIRMED: 'accent',
  CHECKED_IN: 'accent',
  IN_PROGRESS: 'accent',
  COMPLETED: 'success',
  NO_SHOW: 'danger',
  CANCELLED: 'neutral',
  RESCHEDULED: 'neutral',
}

/** Corrida que ainda diz respeito ao pet: cancelada e frustrada não ocupam a perna. */
function live(ride: TaxiRideResponse): boolean {
  return ride.status !== 'CANCELLED' && ride.status !== 'FAILED'
}

/**
 * Os status do agendamento que ainda aceitam pendurar uma corrida.
 *
 * Espelha `CHARGEABLE_APPOINTMENT_STATUSES` do taxidog-service: concluído e cancelado
 * ficam de fora porque o débito já foi (ou não vai) para o ledger, e um item
 * acrescentado depois nunca seria cobrado.
 */
const TAXI_ABLE = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'])

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Aguardando aprovação',
  CONFIRMED: 'Confirmado',
  CHECKED_IN: 'Chegou',
  IN_PROGRESS: 'Em atendimento',
  COMPLETED: 'Concluído',
  NO_SHOW: 'Faltou',
  CANCELLED: 'Cancelado',
  RESCHEDULED: 'Remarcado',
}

function hourOf(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  })
}

function shiftLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function shiftDay(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

export function DayBoard({ view, date, services, taxi, taxiRides }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  /** Qual cartão está com a janela de conclusão aberta. Um por vez. */
  const [concluindo, setConcluindo] = useState<string | null>(null)
  /** Qual cartão está pedindo Taxi Dog. Também um por vez. */
  const [pedindoTaxi, setPedindoTaxi] = useState<string | null>(null)

  function go(to: string) {
    router.push(`/agenda/dia?date=${to}`)
  }

  function act(action: () => Promise<unknown>) {
    startTransition(async () => {
      await action()
      router.refresh()
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost" onClick={() => go(shiftDay(date, -1))}>
            ← Anterior
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => go(new Date().toISOString().slice(0, 10))}
          >
            Hoje
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => go(shiftDay(date, 1))}>
            Próximo →
          </button>
        </div>

        <input
          type="date"
          className="field w-44"
          value={date}
          aria-label="Data da agenda"
          onChange={(event) => go(event.target.value)}
        />
      </div>

      {view.columns.length === 0 ? (
        <Card>
          <p className="hint">
            Nenhum profissional cadastrado ainda. A agenda precisa saber quem atende para
            montar o dia.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {view.columns.map((column) => (
            <Card key={column.professionalId}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  {column.color && (
                    <span
                      aria-hidden
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: column.color }}
                    />
                  )}
                  <h2 className="font-semibold">{column.professionalName}</h2>
                </div>

                {column.absent ? (
                  <Badge tone="neutral">{column.absenceReason ?? 'Ausente'}</Badge>
                ) : (
                  <Badge tone={column.occupancyPercent >= 80 ? 'accent' : 'neutral'}>
                    {column.occupancyPercent}% ocupado
                  </Badge>
                )}
              </div>

              {!column.absent && column.shifts.length > 0 && (
                <p className="hint mt-1">
                  {column.shifts
                    .map((s) => `${shiftLabel(s.startsAtMin)}–${shiftLabel(s.endsAtMin)}`)
                    .join(' · ')}
                  {column.maxConcurrentPets > 1 && ` · até ${column.maxConcurrentPets} pets por vez`}
                </p>
              )}

              <div className="mt-4 space-y-2">
                {column.appointments.length === 0 ? (
                  column.absent ? (
                    <p className="hint">Sem atendimentos neste dia.</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="hint">Agenda livre.</p>
                      <Link
                        href={`/agenda/novo?date=${date}`}
                        className="text-sm underline decoration-line hover:decoration-fg"
                      >
                        Marcar horário
                      </Link>
                    </div>
                  )
                ) : (
                  column.appointments.map((appointment) => {
                    const critical = appointment.alerts.some((a) => a.severity === 'CRITICAL')
                    const rides = (taxiRides[appointment.id] ?? []).filter(live)
                    // Duas pernas por agendamento e ponto: com ida e volta já pedidas
                    // não há o que oferecer, e o botão vira ruído no cartão.
                    const podePedirTaxi =
                      taxi !== null && TAXI_ABLE.has(appointment.status) && rides.length < 2

                    return (
                      <div
                        key={appointment.id}
                        className={`rounded-2xl border px-4 py-3 ${
                          critical ? 'border-danger/50' : 'border-line'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">
                            {hourOf(appointment.startsAt, view.timezone)} · {appointment.petName}
                          </span>
                          <Badge tone={STATUS_TONE[appointment.status] ?? 'neutral'}>
                            {STATUS_LABELS[appointment.status] ?? appointment.status}
                          </Badge>
                        </div>

                        <p className="hint mt-1">{appointment.services.join(', ')}</p>

                        {appointment.alerts.length > 0 && (
                          <ul className="mt-2 flex flex-wrap gap-1.5">
                            {appointment.alerts.map((alert) => (
                              <li key={`${alert.severity}-${alert.label}`}>
                                <Badge tone={alert.severity === 'CRITICAL' ? 'danger' : 'neutral'}>
                                  {alert.label}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        )}

                        {/*
                          A corrida aparece no cartão do atendimento porque quem olha a
                          agenda precisa saber que o pet **não** vem pela porta — e
                          sobretudo que ninguém foi buscá-lo ainda.
                        */}
                        {rides.length > 0 && (
                          <ul className="mt-2 flex flex-wrap gap-1.5">
                            {rides.map((ride) => (
                              <li key={ride.id}>
                                <Badge tone={ride.status === 'REQUESTED' ? 'danger' : 'accent'}>
                                  Taxi {ride.legLabel.toLowerCase()} ·{' '}
                                  {hourOf(ride.windowStartsAt, view.timezone)} ·{' '}
                                  {ride.status === 'REQUESTED' ? 'sem motorista' : ride.statusLabel}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        )}

                        <div className="mt-3 flex flex-wrap gap-2">
                          {appointment.status === 'CONFIRMED' && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={pending}
                              onClick={() => act(() => checkInAction(appointment.id))}
                            >
                              Chegou
                            </button>
                          )}
                          {(appointment.status === 'CHECKED_IN' ||
                            appointment.status === 'IN_PROGRESS') &&
                            concluindo !== appointment.id && (
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={pending}
                                onClick={() => setConcluindo(appointment.id)}
                              >
                                Concluir
                              </button>
                            )}
                          {podePedirTaxi && pedindoTaxi !== appointment.id && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={pending}
                              onClick={() => setPedindoTaxi(appointment.id)}
                            >
                              {rides.length === 0 ? 'Taxi Dog' : 'Pedir a outra perna'}
                            </button>
                          )}
                        </div>

                        {concluindo === appointment.id && (
                          <CheckoutPanel
                            appointment={appointment}
                            services={services}
                            onClose={() => setConcluindo(null)}
                            onDone={() => {
                              setConcluindo(null)
                              router.refresh()
                            }}
                          />
                        )}

                        {taxi && pedindoTaxi === appointment.id && (
                          <TaxiPanel
                            appointment={appointment}
                            timezone={view.timezone}
                            windowMinutes={taxi.windowMinutes}
                            existing={rides}
                            onClose={() => setPedindoTaxi(null)}
                            onDone={() => {
                              setPedindoTaxi(null)
                              router.refresh()
                            }}
                          />
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
