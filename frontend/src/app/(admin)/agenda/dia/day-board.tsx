'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CalendarBlockResponse,
  DayAppointment,
  DayColumn,
  DayView,
  ServiceResponse,
  TaxiRideResponse,
} from '@petshop/shared-types'
import {
  alvoDaRolagem,
  distribuirPistas,
  forasDaJornada,
  horaDe,
  horasDaJanela,
  intervaloDe,
  janelaDoDia,
  minutosNoFuso,
  recortar,
  STATUS_LABELS,
  type Intervalo,
} from '@/lib/agenda-dia'
import { AppointmentDialog, type Vista } from './appointment-dialog'
import { DateRail } from './date-rail'

/**
 * A Agenda do Dia como linha do tempo.
 *
 * Era uma pilha: um cartão por profissional com os atendimentos empilhados dentro, na
 * ordem do horário mas sem relação com ele. A tela respondia "quem atende o quê" e não
 * respondia a pergunta que a recepção faz o dia inteiro — *"tem vaga hoje?"* —, porque
 * duas linhas coladas na pilha tanto podem ser dois banhos seguidos quanto duas horas
 * de buraco entre eles.
 *
 * Aqui o buraco tem tamanho. É a única razão de a tela custar posicionamento absoluto e
 * aritmética de minutos (`lib/agenda-dia.ts`, testada) em vez de continuar sendo uma
 * lista de `<div>`.
 *
 * A coluna do ausente **fica**, marcada (AC-02). Some-se ela e a equipe conclui que o
 * sistema perdeu a pessoa — e o suporte recebe uma ligação.
 *
 * O bloco não carrega ação nenhuma: às 15 minutos ele tem 21px de altura, e não cabe
 * botão. Tudo o que se faz com um atendimento — chegou, concluir, taxi, cancelar —
 * mora na ficha que o clique abre, que é também o único lugar do produto onde tutor,
 * duração e valor do atendimento aparecem juntos.
 */

interface Props {
  view: DayView
  date: string
  /** Hoje no fuso do estabelecimento (RN-12), calculado no servidor. */
  today: string
  /** Catálogo ativo, para o serviço acrescentado durante a execução (RN-18). */
  services: ServiceResponse[]
  /**
   * Taxi Dog ligado e configurado, com a janela padrão do módulo. `null` quando o
   * módulo está desligado, quando o serviço não respondeu ou quando quem olha não
   * tem `taxi:operate` — nos três casos a ficha simplesmente não oferece corrida.
   */
  taxi: { windowMinutes: number } | null
  /** Corridas do dia, agrupadas por agendamento. */
  taxiRides: Record<string, TaxiRideResponse[]>
  /** Bloqueios de calendário do dia — almoço, feriado, manutenção. */
  blocks: CalendarBlockResponse[]
}

/**
 * Altura de um minuto, em pixels.
 *
 * 1,4 põe a hora em 84px e o slot mínimo de 15 minutos (a grade do produto) em 21px —
 * o suficiente para o nome do pet numa linha. Mais que isso e um dia de dez horas não
 * cabe numa tela sem rolagem; menos e os blocos curtos viram tarjas ilegíveis.
 */
const PX_POR_MINUTO = 1.4

/**
 * Altura do cabeçalho fixo da coluna. A calha reserva a mesma para não desalinhar.
 *
 * 6rem é a soma do que ele carrega — nome, medidor e jornada — e não um número
 * escolhido a olho. Com 4,75rem a linha da jornada vazava para dentro da grade e
 * ficava impressa por cima da primeira hora.
 */
const ALTURA_CABECALHO = '6rem'

/**
 * Folga acima da primeira hora, em pixels.
 *
 * O rótulo da hora sobe meia linha para montar na régua, e o da primeira hora subia
 * para dentro do cabeçalho — que é opaco e o cortava ao meio. Empurrar a grade
 * inteira alguns pixels resolve sem mexer no alinhamento entre rótulo e traço.
 */
const FOLGA_TOPO = 12

/**
 * A cor da espinha do bloco, por status.
 *
 * É o que faz a coluna ser varrida antes de ser lida: quatro cores empilhadas contam
 * como está o dia sem uma palavra. A etiqueta com o nome do status continua existindo,
 * dentro da ficha — no bloco ela não caberia.
 */
const COR_DO_STATUS: Record<string, string> = {
  PENDING: 'var(--color-subtle)',
  CONFIRMED: 'var(--color-chart-bar)',
  CHECKED_IN: 'var(--color-icon-pet)',
  IN_PROGRESS: 'var(--color-accent)',
  COMPLETED: 'var(--color-success)',
  NO_SHOW: 'var(--color-danger)',
  CANCELLED: 'var(--color-line)',
  RESCHEDULED: 'var(--color-line)',
}

/** Corrida que ainda diz respeito ao pet: cancelada e frustrada não ocupam a perna. */
function live(ride: TaxiRideResponse): boolean {
  return ride.status !== 'CANCELLED' && ride.status !== 'FAILED'
}

export function DayBoard({ view, date, today, services, taxi, taxiRides, blocks }: Props) {
  const router = useRouter()
  /** Qual atendimento está com a ficha aberta, e em que vista ela abriu. */
  const [aberto, setAberto] = useState<{ appointment: DayAppointment; vista: Vista } | null>(null)

  const { timezone } = view

  /*
   * A faixa desenhada sai de tudo o que o dia tem: jornadas, atendimentos e bloqueios.
   * Recalcular isso a cada `render` não custa nada, mas o `useMemo` mantém a identidade
   * dos intervalos estável entre as renderizações que o diálogo provoca.
   */
  const { janela, colunas, horas, alturaPx } = useMemo(() => {
    const intervalos: Intervalo[] = []

    for (const column of view.columns) {
      for (const shift of column.shifts) {
        intervalos.push({ inicioMin: shift.startsAtMin, fimMin: shift.endsAtMin })
      }
      for (const appointment of column.appointments) {
        intervalos.push(intervaloDe(appointment.startsAt, appointment.endsAt, timezone, date))
      }
    }
    for (const block of blocks) {
      intervalos.push(intervaloDe(block.startsAt, block.endsAt, timezone, date))
    }

    const janela = janelaDoDia(intervalos)

    const colunas = view.columns.map((column) => {
      const eventos = column.appointments
        .map((appointment) => ({
          item: appointment,
          intervalo: intervaloDe(appointment.startsAt, appointment.endsAt, timezone, date),
        }))
        .flatMap((evento) => {
          const dentro = recortar(evento.intervalo, janela)
          return dentro ? [{ ...evento, intervalo: dentro }] : []
        })

      return {
        column,
        eventos: distribuirPistas(eventos),
        foras: forasDaJornada(janela, column.shifts.map(paraIntervalo)),
        /*
         * O bloqueio de escopo `TENANT` vale para todo mundo (feriado, dedetização) e
         * por isso aparece em **todas** as colunas; o de escopo `PROFESSIONAL` só na
         * de quem ele bloqueia.
         */
        bloqueios: blocks
          .filter(
            (block) =>
              block.professionalId === null || block.professionalId === column.professionalId,
          )
          .flatMap((block) => {
            const dentro = recortar(
              intervaloDe(block.startsAt, block.endsAt, timezone, date),
              janela,
            )
            return dentro ? [{ block, intervalo: dentro }] : []
          }),
      }
    })

    return {
      janela,
      colunas,
      horas: horasDaJanela(janela),
      alturaPx: (janela.fimMin - janela.inicioMin) * PX_POR_MINUTO + FOLGA_TOPO * 2,
    }
  }, [view.columns, blocks, timezone, date])

  const agora = useAgora(timezone, date === today)

  const caixaRef = useRef<HTMLDivElement>(null)
  const cabecalhoRef = useRef<HTMLDivElement>(null)
  const fioRef = useRef<HTMLDivElement>(null)
  useRolarAteAgora({ agora, caixaRef, cabecalhoRef, fioRef })

  const topoDe = (minutos: number): number =>
    FOLGA_TOPO + (minutos - janela.inicioMin) * PX_POR_MINUTO

  const total = view.columns.reduce((soma, coluna) => soma + coluna.appointments.length, 0)

  function abrir(appointment: DayAppointment, vista: Vista = 'ficha') {
    setAberto({ appointment, vista })
  }

  return (
    <div className="space-y-5">
      <DateRail
        date={date}
        today={today}
        onPick={(escolhido) => router.push(`/agenda/dia?date=${escolhido}`)}
      />

      <DaySummary columns={view.columns} />

      {view.columns.length === 0 ? (
        <div className="card p-6 sm:p-8">
          <p className="hint">
            Nenhum profissional cadastrado ainda. A agenda precisa saber quem atende para
            montar o dia.
          </p>
        </div>
      ) : (
        <>
          <div className="timeline" ref={caixaRef}>
            <div className="timeline-grid" style={{ height: `calc(${ALTURA_CABECALHO} + ${alturaPx}px)` }}>
              {/* ─── Calha de horas ────────────────────────────────────────── */}
              <div className="timeline-gutter">
                <div
                  ref={cabecalhoRef}
                  className="timeline-head"
                  style={{ height: ALTURA_CABECALHO }}
                />
                <div className="relative" style={{ height: alturaPx }}>
                  {horas.map((minuto) => (
                    <span key={minuto} className="timeline-hour-label" style={{ top: topoDe(minuto) }}>
                      {horaDe(minuto)}
                    </span>
                  ))}
                </div>
              </div>

              {/* ─── Uma coluna por profissional ───────────────────────────── */}
              {colunas.map(({ column, eventos, foras, bloqueios }) => (
                <div
                  key={column.professionalId}
                  className={`timeline-col ${column.absent ? 'timeline-col-off' : ''}`}
                >
                  <ColumnHead column={column} />

                  <div className="relative" style={{ height: alturaPx }}>
                    {/* Pauta: linha cheia na hora, tracejada na meia. */}
                    {horas.map((minuto) => (
                      <div key={minuto}>
                        <div className="timeline-hour" style={{ top: topoDe(minuto) }} />
                        {minuto + 30 < janela.fimMin && (
                          <div className="timeline-half" style={{ top: topoDe(minuto + 30) }} />
                        )}
                      </div>
                    ))}

                    {/* Fora do expediente: véu, não outra cor. */}
                    {foras.map((fora) => (
                      <div
                        key={`fora-${fora.inicioMin}`}
                        aria-hidden
                        className="timeline-closed"
                        style={{
                          top: topoDe(fora.inicioMin),
                          height: (fora.fimMin - fora.inicioMin) * PX_POR_MINUTO,
                        }}
                      />
                    ))}

                    {bloqueios.map(({ block, intervalo }) => (
                      <div
                        key={block.id}
                        className="timeline-block"
                        style={{
                          top: topoDe(intervalo.inicioMin),
                          height: (intervalo.fimMin - intervalo.inicioMin) * PX_POR_MINUTO,
                        }}
                      >
                        <span className="block px-2 py-1 text-[0.6875rem] font-medium text-muted">
                          {block.reason ?? 'Indisponível'}
                        </span>
                      </div>
                    ))}

                    <ul>
                      {eventos.map(({ item: appointment, intervalo, pista, pistas }) => (
                        <li key={appointment.id}>
                          <EventBlock
                            appointment={appointment}
                            top={topoDe(intervalo.inicioMin)}
                            altura={(intervalo.fimMin - intervalo.inicioMin) * PX_POR_MINUTO}
                            pista={pista}
                            pistas={pistas}
                            timezone={timezone}
                            rides={(taxiRides[appointment.id] ?? []).filter(live)}
                            onOpen={() => abrir(appointment)}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}

              {/* O fio do agora atravessa as colunas, com o ponto na calha. */}
              {agora !== null && agora >= janela.inicioMin && agora <= janela.fimMin && (
                <div
                  ref={fioRef}
                  aria-hidden
                  className="timeline-now"
                  style={{ top: `calc(${ALTURA_CABECALHO} + ${topoDe(agora)}px)` }}
                />
              )}
            </div>
          </div>

          {total === 0 && (
            <p className="hint text-center">
              Nenhum atendimento marcado neste dia.{' '}
              <Link
                href={`/agenda/novo?date=${date}`}
                className="underline decoration-line hover:decoration-fg"
              >
                Marcar horário
              </Link>
            </p>
          )}
        </>
      )}

      {aberto && (
        <AppointmentDialog
          appointment={aberto.appointment}
          vistaInicial={aberto.vista}
          timezone={timezone}
          professionalName={nomeDoProfissional(view, aberto.appointment.id)}
          services={services}
          taxi={taxi}
          rides={(taxiRides[aberto.appointment.id] ?? []).filter(live)}
          onClose={() => setAberto(null)}
          onDone={() => {
            setAberto(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

// ─── Peças ───────────────────────────────────────────────────────────────────

/**
 * A tira de números acima da linha do tempo.
 *
 * Estava no subtítulo da página, escrita em prosa ("12 atendimentos · 3 em andamento").
 * Como frase ela era lida uma vez e ignorada; como três números alinhados, é conferida
 * de relance a cada volta à tela — que é o uso real.
 */
function DaySummary({ columns }: { columns: DayColumn[] }) {
  const atendimentos = columns.flatMap((column) => column.appointments)
  const contar = (...status: string[]): number =>
    atendimentos.filter((appointment) => status.includes(appointment.status)).length

  const ativas = columns.filter((column) => !column.absent)
  const ocupacao =
    ativas.length === 0
      ? 0
      : Math.round(ativas.reduce((soma, c) => soma + c.occupancyPercent, 0) / ativas.length)

  const numeros = [
    { label: 'Marcados', valor: atendimentos.length },
    { label: 'Em andamento', valor: contar('CHECKED_IN', 'IN_PROGRESS') },
    { label: 'Concluídos', valor: contar('COMPLETED') },
    { label: 'Ocupação', valor: `${ocupacao}%` },
  ]

  return (
    <div className="card flex flex-wrap gap-x-8 gap-y-3 px-5 py-4">
      {numeros.map((numero) => (
        <div key={numero.label}>
          <p className="text-xl font-semibold tabular-nums">{numero.valor}</p>
          <p className="section-eyebrow mt-0.5">{numero.label}</p>
        </div>
      ))}
    </div>
  )
}

/**
 * O cabeçalho da coluna, fixo na rolagem vertical.
 *
 * Rolando até as 17h com quatro profissionais na tela, uma coluna sem nome no topo é
 * uma coluna que não se sabe de quem é — e o clique errado vira um check-out no pet do
 * colega.
 *
 * O medidor substitui a etiqueta "72% ocupado": o número sozinho exige comparação
 * mental entre as colunas, e quatro barras de comprimentos diferentes entregam a
 * comparação pronta.
 */
function ColumnHead({ column }: { column: DayColumn }) {
  const cor = column.color ?? 'var(--color-chart-bar)'

  return (
    <div className="timeline-head" style={{ height: ALTURA_CABECALHO }}>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-6 w-6 flex-none items-center justify-center rounded-lg text-[0.625rem] font-semibold"
          style={{ backgroundColor: `color-mix(in srgb, ${cor} 16%, transparent)`, color: cor }}
        >
          {iniciaisDe(column.professionalName)}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{column.professionalName}</p>
      </div>

      {column.absent ? (
        <p className="hint mt-2 truncate">{column.absenceReason ?? 'Ausente'}</p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <div className="meter flex-1">
              <div
                className={`meter-fill ${column.occupancyPercent >= 80 ? 'meter-fill-full' : ''}`}
                style={{ width: `${Math.min(100, column.occupancyPercent)}%` }}
              />
            </div>
            <span className="text-[0.6875rem] font-semibold tabular-nums text-subtle">
              {column.occupancyPercent}%
            </span>
          </div>
          <p className="mt-1 truncate text-[0.6875rem] text-subtle tabular-nums">
            {column.shifts.length === 0
              ? 'Sem expediente'
              : column.shifts.map((s) => `${horaDe(s.startsAtMin)}–${horaDe(s.endsAtMin)}`).join(' · ')}
            {column.maxConcurrentPets > 1 && ` · ${column.maxConcurrentPets} por vez`}
          </p>
        </>
      )}
    </div>
  )
}

/**
 * O bloco do atendimento.
 *
 * O que aparece depende da altura, e não de uma regra de conteúdo: num bloco de 21px
 * cabe o nome, num de 84px cabem os serviços. `aria-label` carrega a frase inteira
 * sempre — o texto visível é cortado pelo `overflow`, e um leitor de tela não deve
 * herdar um recorte que existe por falta de pixel.
 */
function EventBlock({
  appointment,
  top,
  altura,
  pista,
  pistas,
  timezone,
  rides,
  onOpen,
}: {
  appointment: DayAppointment
  top: number
  altura: number
  pista: number
  pistas: number
  timezone: string
  rides: TaxiRideResponse[]
  onOpen: () => void
}) {
  const critico = appointment.alerts.some((alerta) => alerta.severity === 'CRITICAL')
  const concluido = appointment.status === 'COMPLETED'
  const inicio = horaDe(minutosNoFuso(appointment.startsAt, timezone))
  const fim = horaDe(minutosNoFuso(appointment.endsAt, timezone))
  /*
   * O mínimo é o que comporta uma linha de texto com o respiro do bloco: 4px de
   * `padding` em cima e embaixo mais os 17px da linha do título. Abaixo disso o nome
   * do pet sai cortado ao meio, que é pior que um bloco 5px mais alto que a duração.
   */
  const alturaFinal = Math.max(altura, 26)
  const semMotorista = rides.some((ride) => ride.status === 'REQUESTED')

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${inicio} às ${fim}, ${appointment.petName}, ${appointment.services.join(', ')} — ${
        STATUS_LABELS[appointment.status] ?? appointment.status
      }${critico ? '. Tem alerta crítico' : ''}`}
      className={`timeline-event ${concluido ? 'timeline-event-done' : ''} ${
        critico ? 'timeline-event-critical' : ''
      }`}
      style={{
        top,
        height: alturaFinal,
        left: `calc(${(pista / pistas) * 100}% + 4px)`,
        width: `calc(${100 / pistas}% - 8px)`,
        borderLeftColor: COR_DO_STATUS[appointment.status] ?? 'var(--color-line)',
      }}
    >
      <span className="timeline-event-title truncate">
        {critico && <span aria-hidden className="mr-1 text-danger">▲</span>}
        {appointment.petName}
        {semMotorista && <span aria-hidden className="ml-1 text-danger">•</span>}
      </span>

      {alturaFinal >= 40 && (
        <span className="timeline-event-meta truncate">
          {inicio}–{fim}
        </span>
      )}
      {alturaFinal >= 62 && (
        <span className="timeline-event-meta truncate">{appointment.services.join(', ')}</span>
      )}
    </button>
  )
}

// ─── Auxiliares ──────────────────────────────────────────────────────────────

function paraIntervalo(shift: { startsAtMin: number; endsAtMin: number }): Intervalo {
  return { inicioMin: shift.startsAtMin, fimMin: shift.endsAtMin }
}

function iniciaisDe(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return '—'
  return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? (partes.at(-1)?.[0] ?? '') : '')).toUpperCase()
}

function nomeDoProfissional(view: DayView, appointmentId: string): string {
  const coluna = view.columns.find((column) =>
    column.appointments.some((appointment) => appointment.id === appointmentId),
  )
  return coluna?.professionalName ?? '—'
}

/**
 * Abre a agenda de hoje já no horário de agora.
 *
 * O dia desenhado vai da primeira jornada ao último atendimento — dez, doze horas —, e
 * a caixa mostra umas seis. Sem isto, quem abre a tela às 15h cai nas 8h da manhã e rola
 * até achar o presente, toda vez. A recepção abre esta tela dezenas de vezes por dia.
 *
 * **Uma vez só, e não a cada tique do relógio.** O fio do agora se move de minuto em
 * minuto; rolar junto arrancaria a tela de quem foi olhar a tarde. O `useRef` é o que
 * separa "abriu a tela" de "o relógio andou" — estado não serviria, porque mudá-lo
 * provocaria o render que o próprio efeito observa.
 *
 * A trava **destrava** quando o fio some, isto é, quando se navega para outro dia: voltar
 * para hoje é abrir a tela de novo, e merece o mesmo posicionamento.
 *
 * Onde exatamente o fio para é conta de `alvoDaRolagem`, em `lib/agenda-dia.ts`, que é
 * pura e testada — o que sobra aqui é medir os elementos e atribuir o `scrollTop`.
 *
 * Salto seco, sem animação: a tela ainda não foi olhada quando isto acontece, e conteúdo
 * que desliza sozinho ao abrir desorienta em vez de orientar.
 */
function useRolarAteAgora({
  agora,
  caixaRef,
  cabecalhoRef,
  fioRef,
}: {
  agora: number | null
  caixaRef: React.RefObject<HTMLDivElement | null>
  cabecalhoRef: React.RefObject<HTMLDivElement | null>
  fioRef: React.RefObject<HTMLDivElement | null>
}): void {
  const jaRolou = useRef(false)

  useEffect(() => {
    // Outro dia não tem "agora": a trava volta ao lugar para quando hoje voltar.
    if (agora === null) {
      jaRolou.current = false
      return
    }
    if (jaRolou.current) return

    const caixa = caixaRef.current
    const fio = fioRef.current
    // Sem fio, o agora caiu fora da faixa desenhada — antes de abrir ou depois de
    // fechar. O topo é a resposta certa nos dois casos, e é onde a caixa já está.
    if (!caixa || !fio) return

    // Medida, e não `6rem` repetido aqui: a altura do cabeçalho entra na conta porque
    // ele é grudado no topo da caixa e cobriria o fio. Duplicar a constante a faria
    // divergir do CSS no dia em que o cabeçalho mudasse de tamanho.
    caixa.scrollTop = alvoDaRolagem({
      topoDoFio: fio.offsetTop,
      alturaCaixa: caixa.clientHeight,
      alturaCabecalho: cabecalhoRef.current?.offsetHeight ?? 0,
    })
    jaRolou.current = true
  }, [agora, caixaRef, cabecalhoRef, fioRef])
}

/**
 * O minuto atual no fuso do estabelecimento, ou `null` fora de hoje.
 *
 * Nasce `null` e só é preenchido no efeito **de propósito**: o servidor renderiza num
 * instante e o browser hidrata em outro, e um fio do "agora" calculado nos dois lados
 * é uma divergência de hidratação garantida. Fora de hoje ele não existe — um fio
 * marcando 14h20 na agenda de terça que vem não significa nada.
 */
function useAgora(timezone: string, ehHoje: boolean): number | null {
  const [agora, setAgora] = useState<number | null>(null)

  useEffect(() => {
    if (!ehHoje) {
      setAgora(null)
      return
    }

    const marcar = () => setAgora(minutosNoFuso(new Date().toISOString(), timezone))
    marcar()
    const timer = setInterval(marcar, 60_000)
    return () => clearInterval(timer)
  }, [timezone, ehHoje])

  return agora
}
