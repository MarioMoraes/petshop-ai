'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addDays,
  formatBRL,
  type CalendarBlockResponse,
  type DayAppointment,
  type DayColumn,
  type DayView,
  type TaxiRideResponse,
  titleCase,
} from '@petshop/shared-types'
import {
  alvoDaRolagem,
  distribuirPistas,
  escalaDoMural,
  forasDaJornada,
  horaDe,
  horasDaJanela,
  intervaloDe,
  janelaDoDia,
  minutosNoFuso,
  recortar,
  rotuloDoDia,
  STATUS_LABELS,
  type ComPistas,
  type Intervalo,
} from '@/lib/agenda-dia'

/**
 * O Mural: o dia inteiro numa tela só.
 *
 * A geometria é a mesma da Agenda do Dia — janela desenhada, pistas para o que se
 * sobrepõe, blocos em posição absoluta — e por isso a aritmética continua saindo de
 * `lib/agenda-dia.ts`, que é testada. O que muda é **quem manda na escala**: lá ela é
 * constante e a caixa rola; aqui ela é a divisão da altura da janela pela duração do
 * expediente, e a rolagem só volta quando o dia é longo demais para caber legível.
 *
 * O material é outro de propósito. O Admin é cinza frio com um acento quente porque é
 * uma tela de trabalho, lida de perto e por minutos. O Mural fica ligado num monitor de
 * balcão o dia inteiro e é lido de longe e de relance: no escuro a cor do status é a
 * única coisa que emite luz, e a coluna se varre antes de se ler. Um fundo claro do
 * tamanho da tela faria o contrário — o branco seria a coisa mais forte, e os blocos,
 * o ruído por cima dele.
 */

interface Props {
  view: DayView
  date: string
  /** Hoje no fuso do estabelecimento (RN-12), calculado no servidor. */
  today: string
  tenantName: string
  /** Corridas do dia, agrupadas por agendamento. */
  taxiRides: Record<string, TaxiRideResponse[]>
  blocks: CalendarBlockResponse[]
}

/**
 * Altura do cabeçalho da coluna, em pixels.
 *
 * Número e não `rem` porque ele entra numa conta: é o que se desconta da altura da
 * janela antes de dividir pela duração do dia. Vindo de uma classe, a escala erraria por
 * 80px e o pé do expediente ficaria sempre fora da tela.
 */
const ALTURA_CABECALHO = 80

/** Folga acima da primeira hora e abaixo da última, para o rótulo não montar na borda. */
const FOLGA = 14

/**
 * A cor do status no escuro.
 *
 * Não são as mesmas de `COR_DO_STATUS` da Agenda do Dia. Aquelas foram escolhidas para
 * ter contraste **contra o branco** do cartão; sobre um fundo quase preto, o verde de
 * `--color-success` (#1f7a4d) fica mais escuro que a coluna e o bloco concluído some.
 * Cada uma aqui é o mesmo matiz alguns degraus acima em clareza.
 */
const COR_DO_STATUS: Record<string, string> = {
  PENDING: '#8f96a3',
  CONFIRMED: '#7aa7e8',
  CHECKED_IN: '#e3ad3f',
  IN_PROGRESS: '#ff6a4d',
  COMPLETED: '#3fbf83',
  NO_SHOW: '#f0574c',
  CANCELLED: '#4c515b',
  RESCHEDULED: '#4c515b',
}

/** A legenda do pé: as quatro cores que a equipe precisa distinguir de longe. */
const LEGENDA = ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'] as const

/** Corrida que ainda diz respeito ao pet: cancelada e frustrada não ocupam a perna. */
function live(ride: TaxiRideResponse): boolean {
  return ride.status !== 'CANCELLED' && ride.status !== 'FAILED'
}

export function MuralBoard({ view, date, today, tenantName, taxiRides, blocks }: Props) {
  const router = useRouter()
  const { timezone } = view
  const ehHoje = date === today

  /*
   * A gaveta guarda o **id**, e não o agendamento.
   *
   * O Mural se renova sozinho de minuto em minuto (`useRenovar`), e guardar o objeto
   * deixaria aberta, por tempo indeterminado, uma ficha com o status de antes do
   * check-in. Guardando o id, cada renovação a reconstrói do dado novo — e o
   * agendamento que sumiu do dia (cancelado na outra aba) simplesmente fecha a gaveta.
   */
  const [abertoId, setAbertoId] = useState<string | null>(null)

  const { janela, colunas, horas, duracaoMin } = useMemo(
    () => montarDia(view, blocks, date),
    [view, blocks, date],
  )

  const palcoRef = useRef<HTMLDivElement>(null)
  const escala = useEscala(palcoRef, duracaoMin)
  const alturaPx = duracaoMin * escala + FOLGA * 2

  const agora = useAgora(timezone, ehHoje)
  const topoDe = useCallback(
    (minutos: number): number => FOLGA + (minutos - janela.inicioMin) * escala,
    [janela.inicioMin, escala],
  )

  const fioRef = useRef<HTMLDivElement>(null)
  useRolarAteAgora({ agora, palcoRef, fioRef, escala })
  useRenovar(router)

  const irPara = useCallback(
    (destino: string) => {
      setAbertoId(null)
      router.push(`/mural?date=${destino}`)
    },
    [router],
  )
  useAtalhos({ date, today, irPara, fechar: () => setAbertoId(null) })

  const aberto = useMemo(() => acharAtendimento(view, abertoId), [view, abertoId])

  return (
    <div className="mural">
      <MuralTopo
        tenantName={tenantName}
        date={date}
        today={today}
        columns={view.columns}
        agora={agora}
        onIr={irPara}
      />

      <div className="mural-palco" ref={palcoRef}>
        {view.columns.length === 0 ? (
          <p className="mural-sem-coluna">
            Nenhum profissional cadastrado ainda. A agenda precisa saber quem atende para montar o
            dia.
          </p>
        ) : (
          <div
            className="mural-grade"
            style={{ height: ALTURA_CABECALHO + alturaPx, minHeight: '100%' }}
          >
            {/* ─── Calha de horas ──────────────────────────────────────────── */}
            <div className="mural-calha">
              <div className="mural-cabecalho" style={{ height: ALTURA_CABECALHO }} />
              <div className="relative" style={{ height: alturaPx }}>
                {horas.map((minuto) => (
                  <span key={minuto} className="mural-hora-rotulo" style={{ top: topoDe(minuto) }}>
                    {horaDe(minuto)}
                  </span>
                ))}
                {agora !== null && agora >= janela.inicioMin && agora <= janela.fimMin && (
                  <span className="mural-agora-chip" style={{ top: topoDe(agora) }}>
                    {horaDe(agora)}
                  </span>
                )}
              </div>
            </div>

            {/* ─── Uma coluna por profissional ─────────────────────────────── */}
            {colunas.map(({ column, eventos, foras, bloqueios }) => (
              <div
                key={column.professionalId}
                className={`mural-col ${column.absent ? 'mural-col-off' : ''}`}
              >
                <ColunaCabecalho column={column} />

                <div className="relative" style={{ height: alturaPx }}>
                  {horas.map((minuto) => (
                    <div key={minuto}>
                      <div className="mural-hora" style={{ top: topoDe(minuto) }} />
                      {minuto + 30 < janela.fimMin && (
                        <div className="mural-meia" style={{ top: topoDe(minuto + 30) }} />
                      )}
                    </div>
                  ))}

                  {foras.map((fora) => (
                    <div
                      key={`fora-${fora.inicioMin}`}
                      aria-hidden
                      className="mural-fechado"
                      style={{
                        top: topoDe(fora.inicioMin),
                        height: (fora.fimMin - fora.inicioMin) * escala,
                      }}
                    />
                  ))}

                  {bloqueios.map(({ block, intervalo }) => (
                    <div
                      key={block.id}
                      className="mural-bloqueio"
                      style={{
                        top: topoDe(intervalo.inicioMin),
                        height: (intervalo.fimMin - intervalo.inicioMin) * escala,
                      }}
                    >
                      <span className="mural-bloqueio-texto">{block.reason ?? 'Indisponível'}</span>
                    </div>
                  ))}

                  <ul>
                    {eventos.map(({ item: appointment, intervalo, pista, pistas }) => (
                      <li key={appointment.id}>
                        <MuralEvento
                          appointment={appointment}
                          top={topoDe(intervalo.inicioMin)}
                          altura={(intervalo.fimMin - intervalo.inicioMin) * escala}
                          pista={pista}
                          pistas={pistas}
                          timezone={timezone}
                          rides={(taxiRides[appointment.id] ?? []).filter(live)}
                          aberto={appointment.id === abertoId}
                          onOpen={() => setAbertoId(appointment.id)}
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
                className="mural-agora"
                style={{ top: ALTURA_CABECALHO + topoDe(agora) }}
              />
            )}
          </div>
        )}
      </div>

      <MuralRodape date={date} />

      {aberto && (
        <MuralGaveta
          appointment={aberto.appointment}
          professionalName={aberto.professionalName}
          timezone={timezone}
          date={date}
          rides={(taxiRides[aberto.appointment.id] ?? []).filter(live)}
          onClose={() => setAbertoId(null)}
        />
      )}
    </div>
  )
}

// ─── Topo ────────────────────────────────────────────────────────────────────

/**
 * A faixa do topo: que dia é, como ele está indo, e que horas são.
 *
 * Os números do dia entram aqui em vez de um cartão próprio porque o Mural não tem
 * altura a gastar — cada linha acima da grade é uma linha a menos de expediente visível.
 * Na Agenda do Dia eles podem ocupar uma tira inteira; aqui dividem a faixa com a data.
 */
function MuralTopo({
  tenantName,
  date,
  today,
  columns,
  agora,
  onIr,
}: {
  tenantName: string
  date: string
  today: string
  columns: DayColumn[]
  agora: number | null
  onIr: (date: string) => void
}) {
  const atendimentos = columns.flatMap((column) => column.appointments)
  const contar = (...status: string[]): number =>
    atendimentos.filter((appointment) => status.includes(appointment.status)).length

  const ativas = columns.filter((column) => !column.absent)
  const ocupacao =
    ativas.length === 0
      ? 0
      : Math.round(ativas.reduce((soma, c) => soma + c.occupancyPercent, 0) / ativas.length)

  const numeros = [
    { label: 'Marcados', valor: String(atendimentos.length) },
    { label: 'Em andamento', valor: String(contar('CHECKED_IN', 'IN_PROGRESS')) },
    { label: 'Concluídos', valor: String(contar('COMPLETED')) },
    { label: 'Ocupação', valor: `${ocupacao}%` },
  ]

  return (
    <header className="mural-topo">
      <div className="mural-identidade">
        <p className="mural-eyebrow">
          {/* O ponto pulsa só em hoje: fora dele não há nada se renovando para sinalizar. */}
          <span aria-hidden className={date === today ? 'mural-pulso' : 'mural-pulso-off'} />
          {tenantName}
        </p>
        <h1 className="mural-data">{titleCase(rotuloDoDia(date))}</h1>
      </div>

      <div className="mural-numeros">
        {numeros.map((numero) => (
          <div key={numero.label} className="mural-numero">
            <p className="mural-numero-valor">{numero.valor}</p>
            <p className="mural-numero-rotulo">{numero.label}</p>
          </div>
        ))}
      </div>

      <div className="mural-controles">
        <p className="mural-relogio" aria-label={agora === null ? undefined : 'Horário atual'}>
          {agora === null ? '—' : horaDe(agora)}
        </p>

        <div className="mural-navegacao">
          <button
            type="button"
            className="mural-acao mural-acao-icone"
            aria-label="Dia anterior"
            onClick={() => onIr(addDays(date, -1))}
          >
            <Chevron direction="left" />
          </button>
          {date === today ? (
            <span className="mural-hoje-marca">Hoje</span>
          ) : (
            <button type="button" className="mural-acao" onClick={() => onIr(today)}>
              Hoje
            </button>
          )}
          <button
            type="button"
            className="mural-acao mural-acao-icone"
            aria-label="Próximo dia"
            onClick={() => onIr(addDays(date, 1))}
          >
            <Chevron direction="right" />
          </button>
        </div>

        <TelaCheia />
      </div>
    </header>
  )
}

/**
 * O botão de tela cheia.
 *
 * Nasce **sem** decidir se está em tela cheia: `document.fullscreenElement` só existe no
 * navegador, e lê-lo no primeiro render divergiria da marcação do servidor. O estado
 * real chega pelo evento `fullscreenchange`, que é também o que mantém o rótulo certo
 * quando a pessoa sai pelo Esc em vez de pelo botão.
 */
function TelaCheia() {
  const [cheia, setCheia] = useState(false)

  useEffect(() => {
    const sincronizar = () => setCheia(document.fullscreenElement !== null)
    sincronizar()
    document.addEventListener('fullscreenchange', sincronizar)
    return () => document.removeEventListener('fullscreenchange', sincronizar)
  }, [])

  return (
    <button
      type="button"
      className="mural-acao mural-acao-icone"
      aria-label={cheia ? 'Sair da tela cheia' : 'Tela cheia'}
      title={cheia ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'}
      onClick={() => {
        // A promessa é recusada quando o navegador não teve gesto do usuário, e isso
        // não é erro de tela: o Mural continua exatamente como estava.
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
        else void document.documentElement.requestFullscreen().catch(() => {})
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {cheia ? (
          <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
        ) : (
          <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
        )}
      </svg>
    </button>
  )
}

// ─── Coluna e bloco ──────────────────────────────────────────────────────────

function ColunaCabecalho({ column }: { column: DayColumn }) {
  const cor = column.color ?? '#7aa7e8'
  const marcados = column.appointments.length

  return (
    <div className="mural-cabecalho" style={{ height: ALTURA_CABECALHO }}>
      <div className="mural-cab-linha">
        <span
          aria-hidden
          className="mural-inicial"
          style={{
            color: cor,
            backgroundColor: `color-mix(in srgb, ${cor} 20%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${cor} 40%, transparent)`,
          }}
        >
          {iniciaisDe(column.professionalName)}
        </span>
        <p className="mural-cab-nome">{column.professionalName}</p>
        {!column.absent && <span className="mural-cab-contagem">{marcados}</span>}
      </div>

      {column.absent ? (
        <p className="mural-cab-ausente">{column.absenceReason ?? 'Ausente'}</p>
      ) : (
        <>
          <div className="mural-cab-medidor">
            <div
              className="mural-medidor"
              style={{
                // A barra herda a cor do profissional: no escuro, quatro barras cinzas
                // lado a lado leem como uma régua só e param de comparar nada.
                width: `${Math.min(100, column.occupancyPercent)}%`,
                backgroundColor: column.occupancyPercent >= 80 ? '#ff6a4d' : cor,
              }}
            />
          </div>
          <p className="mural-cab-jornada">
            {column.shifts.length === 0
              ? 'Sem expediente'
              : column.shifts
                  .map((s) => `${horaDe(s.startsAtMin)}–${horaDe(s.endsAtMin)}`)
                  .join(' · ')}
            <span className="mural-cab-ocupacao">{column.occupancyPercent}%</span>
          </p>
        </>
      )}
    </div>
  )
}

/**
 * O bloco do atendimento.
 *
 * O que aparece depende da altura, e não de uma regra de conteúdo — o mesmo critério da
 * Agenda do Dia, com os limiares deslocados porque aqui a escala é maior e um bloco de
 * meia hora costuma ter o dobro do tamanho. `aria-label` carrega a frase inteira sempre.
 */
function MuralEvento({
  appointment,
  top,
  altura,
  pista,
  pistas,
  timezone,
  rides,
  aberto,
  onOpen,
}: {
  appointment: DayAppointment
  top: number
  altura: number
  pista: number
  pistas: number
  timezone: string
  rides: TaxiRideResponse[]
  aberto: boolean
  onOpen: () => void
}) {
  const critico = appointment.alerts.some((alerta) => alerta.severity === 'CRITICAL')
  const concluido = appointment.status === 'COMPLETED'
  const correndo = appointment.status === 'IN_PROGRESS'
  const inicio = horaDe(minutosNoFuso(appointment.startsAt, timezone))
  const fim = horaDe(minutosNoFuso(appointment.endsAt, timezone))
  const cor = COR_DO_STATUS[appointment.status] ?? '#4c515b'
  /*
   * O mínimo é o que comporta uma linha de texto com o respiro do bloco — 18px na forma
   * curta, que encolhe a letra e o respiro justamente para não emprestar altura do
   * vizinho. O que um bloco toma emprestado, o de baixo perde.
   */
  const alturaFinal = Math.max(altura, 18)
  const curto = alturaFinal < 34
  const semMotorista = rides.some((ride) => ride.status === 'REQUESTED')

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${inicio} às ${fim}, ${appointment.petName}, ${appointment.services.join(', ')} — ${
        STATUS_LABELS[appointment.status] ?? appointment.status
      }${critico ? '. Tem alerta crítico' : ''}`}
      className={`mural-evento${curto ? ' mural-evento-curto' : ''}${
        concluido ? ' mural-evento-feito' : ''
      }${correndo ? ' mural-evento-correndo' : ''}${critico ? ' mural-evento-critico' : ''}${
        aberto ? ' mural-evento-aberto' : ''
      }`}
      style={{
        top,
        height: alturaFinal,
        left: `calc(${(pista / pistas) * 100}% + 5px)`,
        width: `calc(${100 / pistas}% - 10px)`,
        // Uma variável só alimenta a espinha, o clarão e o esfumado de dentro: são três
        // usos da mesma cor, e repeti-la nos três desalinharia no primeiro ajuste.
        ['--cor' as string]: cor,
      }}
    >
      <span className="mural-evento-titulo">
        {critico && (
          <span aria-hidden className="mural-evento-alerta">
            ▲
          </span>
        )}
        <span className="mural-evento-nome">{appointment.petName}</span>
        {semMotorista && (
          <span aria-hidden className="mural-evento-taxi" title="Corrida sem motorista">
            ●
          </span>
        )}
      </span>

      {alturaFinal >= 44 && (
        <span className="mural-evento-meta">
          {inicio}–{fim}
        </span>
      )}
      {alturaFinal >= 68 && (
        <span className="mural-evento-meta mural-evento-servicos">
          {appointment.services.join(', ')}
        </span>
      )}
    </button>
  )
}

// ─── Gaveta ──────────────────────────────────────────────────────────────────

/**
 * A ficha do atendimento, só de leitura.
 *
 * O Mural não aprova, não faz check-in e não cancela. Não é limitação de tempo: a
 * máquina de estado do agendamento tem uma superfície de escrita, a ficha da Agenda do
 * Dia, e duplicá-la numa tela pensada para ser olhada de longe cria dois lugares onde a
 * mesma transição pode divergir. Daí o rodapé daqui ser um link para lá, com a data já
 * na busca — quem precisa agir troca de aba com o atendimento na tela.
 */
function MuralGaveta({
  appointment,
  professionalName,
  timezone,
  date,
  rides,
  onClose,
}: {
  appointment: DayAppointment
  professionalName: string
  timezone: string
  date: string
  rides: TaxiRideResponse[]
  onClose: () => void
}) {
  const inicio = horaDe(minutosNoFuso(appointment.startsAt, timezone))
  const fim = horaDe(minutosNoFuso(appointment.endsAt, timezone))
  const cor = COR_DO_STATUS[appointment.status] ?? '#4c515b'

  return (
    <>
      {/* Véu clicável: fora do balcão, fechar com o mouse é mais rápido que achar o Esc. */}
      <button type="button" className="mural-veu" aria-label="Fechar a ficha" onClick={onClose} />

      <aside className="mural-gaveta" aria-label={`Atendimento de ${appointment.petName}`}>
        <div className="mural-gaveta-topo">
          <span className="mural-status" style={{ ['--cor' as string]: cor }}>
            {STATUS_LABELS[appointment.status] ?? appointment.status}
          </span>
          <button
            type="button"
            className="mural-acao mural-acao-icone"
            aria-label="Fechar"
            onClick={onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <h2 className="mural-gaveta-pet">{titleCase(appointment.petName)}</h2>
        <p className="mural-gaveta-horario">
          {inicio}–{fim} · {professionalName}
        </p>

        {appointment.alerts.length > 0 && (
          <ul className="mural-alertas">
            {appointment.alerts.map((alerta) => (
              <li
                key={`${alerta.severity}-${alerta.label}`}
                className={alerta.severity === 'CRITICAL' ? 'mural-alerta-critico' : undefined}
              >
                {alerta.label}
              </li>
            ))}
          </ul>
        )}

        <dl className="mural-dados">
          <Dado rotulo="Serviços">{appointment.services.join(', ') || '—'}</Dado>
          <Dado rotulo="Valor">{formatBRL(appointment.totalCents)}</Dado>
          {appointment.checkinAt && (
            <Dado rotulo="Chegou às">{horaDe(minutosNoFuso(appointment.checkinAt, timezone))}</Dado>
          )}
          {rides.length > 0 && (
            <Dado rotulo="Leva e traz">
              {rides.map((ride) => `${ride.legLabel}: ${ride.statusLabel}`).join(' · ')}
            </Dado>
          )}
        </dl>

        <div className="mural-gaveta-acoes">
          <Link href={`/agenda/dia?date=${date}`} className="mural-acao mural-acao-forte">
            Abrir na Agenda do Dia
          </Link>
          <Link href={`/pets/${appointment.petId}`} className="mural-acao">
            Ficha do pet
          </Link>
        </div>
      </aside>
    </>
  )
}

function Dado({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="mural-dado">
      <dt>{rotulo}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// ─── Rodapé ──────────────────────────────────────────────────────────────────

/** A legenda das cores e os atalhos — a única documentação que esta tela tem. */
function MuralRodape({ date }: { date: string }) {
  return (
    <footer className="mural-rodape">
      <ul className="mural-legenda">
        {LEGENDA.map((status) => (
          <li key={status}>
            <span aria-hidden style={{ backgroundColor: COR_DO_STATUS[status] }} />
            {STATUS_LABELS[status]}
          </li>
        ))}
      </ul>

      <p className="mural-atalhos">
        <kbd>←</kbd> <kbd>→</kbd> muda o dia · <kbd>H</kbd> volta para hoje · <kbd>F</kbd> tela
        cheia
      </p>

      <Link href={`/agenda/dia?date=${date}`} className="mural-acao">
        Agenda do Dia
      </Link>
    </footer>
  )
}

// ─── Auxiliares ──────────────────────────────────────────────────────────────

interface ColunaMontada {
  column: DayColumn
  eventos: ComPistas<DayAppointment>[]
  foras: Intervalo[]
  bloqueios: { block: CalendarBlockResponse; intervalo: Intervalo }[]
}

/**
 * A faixa desenhada e o conteúdo de cada coluna.
 *
 * A mesma montagem da Agenda do Dia, e fora do componente porque aqui ela roda também
 * para decidir a escala — o `useMemo` do componente precisa da duração antes de medir a
 * tela, e a ordem inversa daria uma volta de render a mais em cada troca de dia.
 */
function montarDia(
  view: DayView,
  blocks: CalendarBlockResponse[],
  date: string,
): { janela: Intervalo; colunas: ColunaMontada[]; horas: number[]; duracaoMin: number } {
  const { timezone } = view
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

  const colunas = view.columns.map((column): ColunaMontada => {
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
      foras: forasDaJornada(
        janela,
        column.shifts.map((s) => ({ inicioMin: s.startsAtMin, fimMin: s.endsAtMin })),
      ),
      // O bloqueio de escopo `TENANT` vale para todo mundo e aparece em todas as
      // colunas; o de escopo `PROFESSIONAL` só na de quem ele bloqueia.
      bloqueios: blocks
        .filter(
          (block) =>
            block.professionalId === null || block.professionalId === column.professionalId,
        )
        .flatMap((block) => {
          const dentro = recortar(intervaloDe(block.startsAt, block.endsAt, timezone, date), janela)
          return dentro ? [{ block, intervalo: dentro }] : []
        }),
    }
  })

  return {
    janela,
    colunas,
    horas: horasDaJanela(janela),
    duracaoMin: janela.fimMin - janela.inicioMin,
  }
}

function acharAtendimento(
  view: DayView,
  id: string | null,
): { appointment: DayAppointment; professionalName: string } | null {
  if (!id) return null
  for (const column of view.columns) {
    const appointment = column.appointments.find((item) => item.id === id)
    if (appointment) return { appointment, professionalName: column.professionalName }
  }
  return null
}

function iniciaisDe(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return '—'
  return (
    (partes[0]?.[0] ?? '') + (partes.length > 1 ? (partes.at(-1)?.[0] ?? '') : '')
  ).toUpperCase()
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
}

// ─── Ganchos ─────────────────────────────────────────────────────────────────

/**
 * Quantos pixels vale um minuto, medido da janela de verdade.
 *
 * Nasce no piso — o mesmo valor no servidor e no primeiro render do cliente, senão a
 * hidratação divergiria em cada bloco da tela — e o valor real chega no efeito. O
 * `ResizeObserver` existe porque a janela do Mural muda de tamanho por três motivos que
 * nada têm a ver com render: entrar em tela cheia, girar o tablet, arrastar a borda.
 *
 * A conta em si é `escalaDoMural`, que é pura e testada; o que sobra aqui é medir.
 */
function useEscala(palcoRef: React.RefObject<HTMLDivElement | null>, duracaoMin: number): number {
  const [altura, setAltura] = useState(0)

  useEffect(() => {
    const palco = palcoRef.current
    if (!palco) return

    const observador = new ResizeObserver(([entrada]) => {
      if (entrada) setAltura(entrada.contentRect.height)
    })
    observador.observe(palco)
    return () => observador.disconnect()
  }, [palcoRef])

  return escalaDoMural({
    alturaDisponivel: altura - ALTURA_CABECALHO - FOLGA * 2,
    duracaoMin,
  })
}

/**
 * Traz o agora para a tela quando o dia não coube.
 *
 * Só faz sentido no piso da escala: acima dele o expediente inteiro está visível e não há
 * para onde rolar. A trava é por escala e por dia — mudar de dia e voltar merece o mesmo
 * posicionamento, e entrar em tela cheia (que muda a escala) também.
 */
function useRolarAteAgora({
  agora,
  palcoRef,
  fioRef,
  escala,
}: {
  agora: number | null
  palcoRef: React.RefObject<HTMLDivElement | null>
  fioRef: React.RefObject<HTMLDivElement | null>
  escala: number
}): void {
  const jaRolou = useRef(false)

  useEffect(() => {
    jaRolou.current = false
  }, [escala])

  useEffect(() => {
    if (agora === null) {
      jaRolou.current = false
      return
    }
    if (jaRolou.current) return

    const palco = palcoRef.current
    const fio = fioRef.current
    if (!palco || !fio) return
    // Coube inteiro: não há rolagem, e mexer no `scrollTop` aqui seria um salto à toa.
    if (palco.scrollHeight <= palco.clientHeight + 1) return

    palco.scrollTop = alvoDaRolagem({
      topoDoFio: fio.offsetTop,
      alturaCaixa: palco.clientHeight,
      alturaCabecalho: ALTURA_CABECALHO,
    })
    jaRolou.current = true
  }, [agora, palcoRef, fioRef])
}

/**
 * O minuto atual no fuso do estabelecimento, ou `null` fora de hoje.
 *
 * Nasce `null` e só é preenchido no efeito de propósito: o servidor renderiza num
 * instante e o browser hidrata em outro, e um "agora" calculado nos dois lados é uma
 * divergência de hidratação garantida.
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
    const timer = setInterval(marcar, 30_000)
    return () => clearInterval(timer)
  }, [timezone, ehHoje])

  return agora
}

/**
 * O Mural se renova sozinho.
 *
 * É a diferença entre uma tela de consulta e um painel: ninguém vai apertar F5 num
 * monitor de balcão, e um Mural parado nas 9h da manhã é pior que nenhum — ele **parece**
 * atual. Um minuto é a grade do relógio da tela; menos que isso seria pedir ao backend
 * uma leitura que ninguém consegue perceber.
 *
 * Vale para **qualquer** dia aberto, e não só para hoje. A primeira versão poupava a
 * chamada fora de hoje com o argumento de que a agenda de terça que vem não muda
 * enquanto se olha para ela — o que é falso desde o Portal: o tutor marca horário para
 * a semana seguinte a qualquer hora, e o balcão também. Um Mural deixado na agenda de
 * amanhã mentia exatamente como o de hoje.
 *
 * `router.refresh()` e não `location.reload()` — o React troca só o que mudou, e a
 * rolagem, a gaveta aberta e o estado de tela cheia ficam onde estavam.
 */
function useRenovar(router: ReturnType<typeof useRouter>): void {
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 60_000)
    return () => clearInterval(timer)
  }, [router])
}

/**
 * Os atalhos de teclado.
 *
 * O Mural é a única tela do produto onde eles valem a pena: é a que fica aberta o dia
 * todo, a que se opera de pé e a que não tem menu para clicar. Os atalhos recusam
 * qualquer combinação com modificador — `Cmd+←` é voltar no histórico do navegador, e
 * roubá-lo seria trocar um gesto que todo mundo conhece por um que ninguém pediu.
 */
function useAtalhos({
  date,
  today,
  irPara,
  fechar,
}: {
  date: string
  today: string
  irPara: (date: string) => void
  fechar: () => void
}): void {
  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.metaKey || evento.ctrlKey || evento.altKey) return

      if (evento.key === 'Escape') return fechar()
      if (evento.key === 'ArrowLeft') return irPara(addDays(date, -1))
      if (evento.key === 'ArrowRight') return irPara(addDays(date, 1))
      if (evento.key.toLowerCase() === 'h') return irPara(today)
      if (evento.key.toLowerCase() === 'f') {
        evento.preventDefault()
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
        else void document.documentElement.requestFullscreen().catch(() => {})
      }
    }

    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [date, today, irPara, fechar])
}
