'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  formatBRL,
  type PortalAppointment,
  type PortalAppointmentActions,
  type PortalTaxiRide,
} from '@petshop/shared-types'
import { Badge, Card, FormError } from '@/components/ui'
import { Modal } from '@/components/modal'
import { CalendarIcon, VanIcon } from '@/components/icons'
import { cancelar } from './actions'

/**
 * Um agendamento futuro, com o que dá para fazer com ele (MOD-PORTAL-06).
 *
 * **Os botões vêm do servidor.** `actions` diz se cabe cancelar, se cabe remarcar e
 * quanto custaria cancelar agora — a janela de cancelamento é configuração do petshop e
 * muda sem que ninguém publique front nenhum. Uma tela que decidisse isso sozinha
 * mostraria "Cancelar" para quem já está com o pet no banho.
 *
 * O cancelamento tardio pede confirmação **duas vezes de propósito**: o diálogo abre com
 * o valor da taxa, e o servidor ainda recusa a primeira tentativa se ela chegar sem o
 * reconhecimento. A tela pode estar velha; a regra não.
 */
export function AppointmentCard({
  appointment,
  actions,
  timezone,
}: {
  appointment: PortalAppointment
  actions: PortalAppointmentActions
  timezone: string
}) {
  const router = useRouter()
  const [aberto, setAberto] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [cancelando, startTransition] = useTransition()

  function confirmarCancelamento() {
    setErro(null)
    startTransition(async () => {
      const resultado = await cancelar(appointment.id, actions.cancelIsLate)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      router.refresh()
    })
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium">{dataHoraLonga(appointment.startsAt, timezone)}</p>
          <p className="hint mt-0.5">
            {appointment.petName} · {appointment.services.join(', ')}
          </p>
          <p className="hint">com {appointment.professionalName}</p>
        </div>
        {appointment.awaitingApproval && <Badge tone="accent">Aguardando confirmação</Badge>}
      </div>

      <TaxiStrip rides={appointment.taxi} timezone={timezone} />

      <p className="mt-3 text-sm font-medium">{formatBRL(appointment.totalCents)}</p>

      {(actions.canCancel || actions.canReschedule) && (
        <div className="mt-4 flex gap-2">
          {actions.canReschedule && (
            <Link
              href={`/portal/agendamentos/${appointment.id}/remarcar`}
              className="btn btn-ghost h-9 flex-1"
            >
              Remarcar
            </Link>
          )}
          {actions.canCancel && (
            <button
              type="button"
              className="btn btn-ghost h-9 flex-1"
              onClick={() => setAberto(true)}
            >
              Cancelar
            </button>
          )}
        </div>
      )}

      <Modal
        open={aberto}
        onClose={() => setAberto(false)}
        busy={cancelando}
        icon={<CalendarIcon />}
        tone="icon-time"
        eyebrow="Cancelar"
        title={dataHoraLonga(appointment.startsAt, timezone)}
        subtitle={`${appointment.petName} · ${appointment.services.join(', ')}`}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAberto(false)}
              disabled={cancelando}
            >
              Manter horário
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmarCancelamento}
              disabled={cancelando}
            >
              {cancelando ? 'Cancelando…' : 'Cancelar mesmo assim'}
            </button>
          </>
        }
      >
        {actions.cancelIsLate && actions.cancelFeeCents > 0 ? (
          <p className="text-sm">
            Faltam menos de {actions.cancellationWindowHours}h para o horário. Cancelar agora
            gera uma taxa de <strong>{formatBRL(actions.cancelFeeCents)}</strong>, que entra na
            sua conta com o estabelecimento.
          </p>
        ) : (
          <p className="text-sm">
            O horário volta para a agenda do estabelecimento e não há nenhuma taxa.
          </p>
        )}

        {/*
          AC-06 de MOD-PORTAL-07: as corridas caem junto, e não se cobram. Dizer isso no
          diálogo evita a pergunta seguinte — "e o leva-e-traz, continua?" — que hoje vira
          telefonema.
        */}
        {appointment.taxi.length > 0 && (
          <p className="hint mt-2">
            O leva-e-traz deste horário é cancelado junto, sem cobrança.
          </p>
        )}

        <FormError message={erro} />
      </Modal>
    </Card>
  )
}

/** RN-19: a hora é a do petshop, não a do aparelho de quem está olhando. */
function dataHoraLonga(instant: string, timeZone: string): string {
  const texto = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
  return texto.charAt(0).toUpperCase() + texto.slice(1)
}

/**
 * O leva-e-traz deste agendamento (AC-05 de MOD-PORTAL-07).
 *
 * **Status e janela, e nada mais.** Sem mapa e sem a posição do veículo: o rastreamento
 * por GPS é a questão 7 do MOD-TAXI, está fora da v1, e carrega uma discussão de LGPD
 * sobre localização do trabalhador que não se resolve numa tela. Sem o nome do motorista
 * pelo mesmo motivo — e porque saber quem dirige não muda nada do que o tutor faz.
 *
 * O texto do status vem pronto do servidor. O rótulo do painel — "Sem motorista",
 * "Atribuída" — é escrito para quem opera, e no celular do tutor leria como falha.
 */
export function TaxiStrip({
  rides,
  timezone,
}: {
  rides: PortalTaxiRide[]
  timezone: string
}) {
  if (rides.length === 0) return null

  return (
    <div className="mt-3 flex flex-col gap-2">
      {rides.map((ride) => (
        <div key={ride.id} className="flex items-start gap-2 text-sm">
          <span className="text-muted mt-0.5 shrink-0">
            <VanIcon />
          </span>
          <span className="min-w-0">
            <span className="block">
              {ride.legLabel} · <strong className="font-medium">{ride.statusText}</strong>
            </span>
            <span className="hint block">
              entre {hora(ride.windowStartsAt, timezone)} e {hora(ride.windowEndsAt, timezone)}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

function hora(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}
