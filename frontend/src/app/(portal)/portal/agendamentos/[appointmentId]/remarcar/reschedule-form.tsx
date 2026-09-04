'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatBRL, type PortalAppointmentDetail, type PortalSlot } from '@petshop/shared-types'
import { Alert, Card, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, CalendarIcon } from '@/components/icons'
import { carregarHorarios } from '../../../agendar/actions'
import { remarcar } from '../../actions'

/**
 * A escolha do horário novo.
 *
 * Reusa a ação `carregarHorarios` do agendamento, e não uma cópia: a grade é a mesma
 * pergunta com os mesmos serviços — o que muda é o destino da confirmação. Duas versões
 * disso divergiriam no dia em que a antecedência mínima passasse a filtrar diferente.
 *
 * O horário atual fica visível o tempo todo, no topo. Sem ele, quem abre a tela para
 * "adiantar meia hora" perde a referência do que está mudando.
 */
export function RescheduleForm({ appointment }: { appointment: PortalAppointmentDetail }) {
  const router = useRouter()
  const [dia, setDia] = useState('')
  const [horarios, setHorarios] = useState<PortalSlot[]>([])
  const [proximo, setProximo] = useState<string | null>(null)
  const [fuso, setFuso] = useState('America/Sao_Paulo')
  const [escolhido, setEscolhido] = useState<PortalSlot | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, startTransition] = useTransition()

  useEffect(() => {
    if (dia === '') return
    setEscolhido(null)
    setErro(null)

    startTransition(async () => {
      const resultado = await carregarHorarios({
        petId: appointment.petId,
        serviceIds: appointment.serviceIds,
        date: dia,
      })

      if (!resultado.ok) {
        setErro(resultado.message)
        setHorarios([])
        return
      }
      setHorarios(resultado.slots)
      setProximo(resultado.nextAvailable)
      setFuso(resultado.timezone)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dia])

  function confirmar() {
    if (!escolhido) return
    setErro(null)

    startTransition(async () => {
      const resultado = await remarcar(appointment.id, {
        startsAt: escolhido.startsAt,
        professionalId: escolhido.professionalId,
      })

      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      router.push('/portal/agendamentos')
      router.refresh()
    })
  }

  return (
    <>
      <Card>
        <p className="section-eyebrow">Horário de hoje</p>
        <p className="mt-1 text-base font-medium">
          {dataHoraLonga(appointment.startsAt, fuso)}
        </p>
        <p className="hint mt-0.5">
          com {appointment.professionalName} · {formatBRL(appointment.totalCents)}
        </p>
      </Card>

      <Card>
        <SectionHead icon={<CalendarIcon />} tone="icon-time" eyebrow="Novo horário" title="Que dia" />
        <input
          type="date"
          className="field mt-4"
          value={dia}
          min={hojeISO()}
          onChange={(evento) => setDia(evento.target.value)}
          aria-label="Novo dia do agendamento"
        />

        {dia !== '' && (
          <div className="mt-4">
            {horarios.length === 0 ? (
              <p className="hint">
                {ocupado
                  ? 'Procurando horários…'
                  : proximo
                    ? `Não há horário neste dia. O próximo disponível é ${dataHoraLonga(proximo, fuso)}.`
                    : 'Não há horário disponível neste dia.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {horarios.map((slot) => (
                  <button
                    key={`${slot.startsAt}-${slot.professionalId}`}
                    type="button"
                    onClick={() => setEscolhido(slot)}
                    aria-pressed={escolhido?.startsAt === slot.startsAt}
                    className={`btn ${
                      escolhido?.startsAt === slot.startsAt ? 'btn-primary' : 'btn-ghost'
                    } h-10 px-4`}
                  >
                    {hora(slot.startsAt, fuso)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {erro && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não deu para remarcar">
          {erro}
        </Alert>
      )}

      {escolhido && (
        <Card>
          <p className="text-sm">
            O horário passa para <strong>{dataHoraLonga(escolhido.startsAt, fuso)}</strong>, com{' '}
            {escolhido.professionalName}. O preço é recalculado para a nova data.
          </p>
          <button
            type="button"
            className="btn btn-primary mt-4 w-full"
            onClick={confirmar}
            disabled={ocupado}
          >
            {ocupado ? 'Remarcando…' : 'Confirmar novo horário'}
          </button>
        </Card>
      )}
    </>
  )
}

function hojeISO(): string {
  const agora = new Date()
  const local = new Date(agora.getTime() - agora.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function hora(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}

/** RN-19: a hora é a do petshop, não a do aparelho de quem está olhando. */
function dataHoraLonga(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}
