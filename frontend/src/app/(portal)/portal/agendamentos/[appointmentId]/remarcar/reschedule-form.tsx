'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatBRL, type PortalAppointmentDetail, type PortalSlot } from '@petshop/shared-types'
import { Alert, Button, Card, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, CalendarIcon, VanIcon } from '@/components/icons'
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
export function RescheduleForm({
  appointment,
  timezone,
}: {
  appointment: PortalAppointmentDetail
  /**
   * RN-19: o fuso do petshop, vindo do contexto e **não** de um padrão da tela.
   *
   * O cartão do topo mostra o horário atual antes de existir grade nenhuma. Enquanto o
   * fuso nascia cravado em São Paulo, esse horário aparecia errado para o tenant de
   * outro fuso e se corrigia sozinho quando a primeira busca respondia — o pior dos dois
   * mundos, porque quem leu primeiro não viu a correção.
   */
  timezone: string
}) {
  const router = useRouter()
  const [dia, setDia] = useState('')
  const [horarios, setHorarios] = useState<PortalSlot[]>([])
  const [proximo, setProximo] = useState<string | null>(null)
  const [fuso, setFuso] = useState(timezone)
  const [escolhido, setEscolhido] = useState<PortalSlot | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, startTransition] = useTransition()

  /**
   * Só a última busca vale.
   *
   * Mesma guarda do assistente de agendamento: trocar de dia duas vezes num 4G ruim
   * deixa duas buscas no ar, e sem a marca a que chegar por último pinta a grade —
   * ainda que seja a resposta do dia anterior.
   */
  const buscaId = useRef(0)

  useEffect(() => {
    if (dia === '') return
    const marca = ++buscaId.current
    setEscolhido(null)
    setErro(null)
    // A grade do dia anterior sai da tela antes da nova chegar: mantê-la visível
    // ofereceria horários de outro dia para clicar, e o cartão de confirmação diria
    // um dia que o tutor não escolheu.
    setHorarios([])
    setProximo(null)

    startTransition(async () => {
      const resultado = await carregarHorarios({
        petId: appointment.petId,
        serviceIds: appointment.serviceIds,
        date: dia,
      })
      if (marca !== buscaId.current) return

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
        <SectionHead
          icon={<CalendarIcon />}
          tone="icon-time"
          eyebrow="Hoje está marcado"
          title={dataHoraLonga(appointment.startsAt, fuso)}
        />
        <p className="hint mt-2">
          com {appointment.professionalName} · {formatBRL(appointment.totalCents)}
        </p>
      </Card>

      <Card>
        <SectionHead
          icon={<CalendarIcon />}
          tone="icon-time"
          eyebrow="Novo horário"
          title="Que dia"
        />
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
                {horarios.map((slot) => {
                  /*
                   * Dois profissionais livres na mesma hora são dois horários, e a chave
                   * da lista já dizia isso. Comparar só pelo instante acendia os dois
                   * botões de uma vez, sem dizer qual deles estava escolhido.
                   */
                  const marcado =
                    escolhido?.startsAt === slot.startsAt &&
                    escolhido.professionalId === slot.professionalId
                  return (
                    <Button
                      key={`${slot.startsAt}-${slot.professionalId}`}
                      type="button"
                      variant={marcado ? 'primary' : 'ghost'}
                      className="h-10 px-4"
                      onClick={() => {
                        setEscolhido(slot)
                        setErro(null)
                      }}
                      aria-pressed={marcado}
                    >
                      {hora(slot.startsAt, fuso)}
                    </Button>
                  )
                })}
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

      {/*
        RN-15 do MOD-TAXI: remarcar **não** move a corrida.
        O agendamento novo é outro registro, e mover a janela sozinho assumiria que o
        motorista está livre no dia novo — o que ninguém verificou. As corridas antigas
        são canceladas em cascata, e o tutor precisa saber disso **antes** de confirmar:
        descobrir na porta de casa que ninguém vem buscar é o pior jeito de aprender a
        regra.
      */}
      {appointment.taxi.length > 0 && (
        <Alert tone="accent" icon={<VanIcon />} title="O leva-e-traz não vai junto" role="status">
          Ao remarcar, o transporte deste horário é cancelado. Peça de novo marcando um horário novo
          com leva-e-traz, ou fale com o estabelecimento.
        </Alert>
      )}

      {escolhido && (
        <Card>
          <p className="text-sm">
            O horário passa para <strong>{dataHoraLonga(escolhido.startsAt, fuso)}</strong>, com{' '}
            {escolhido.professionalName}. O preço é recalculado para a nova data.
          </p>
          <Button
            type="button"
            className="mt-4 w-full"
            onClick={confirmar}
            busy={ocupado}
            busyLabel="Remarcando…"
          >
            Confirmar novo horário
          </Button>
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
