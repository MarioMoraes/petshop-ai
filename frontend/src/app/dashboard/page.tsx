import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { formatBRL, todayIn, type AppointmentResponse, type DayView } from '@petshop/shared-types'
import { AppShell } from '@/components/app-shell'
import { CardBloom } from '@/components/atmosphere'
import {
  CalendarIcon,
  PawPrintIcon,
  TrendingUpIcon,
  UsersIcon,
  WalletIcon,
  type IconTone,
} from '@/components/icons'
import { serverApi } from '@/lib/api'
import { Roadmap } from './roadmap'

/**
 * Início — o painel do estabelecimento.
 *
 * Já foi um checklist de onboarding ("cadastre seu primeiro tutor", "convide sua
 * equipe"). Não é mais: terminar a configuração e continuar sendo cobrado por tarefas
 * faz o produto parecer que nunca começou. O que fica é o estado do negócio.
 *
 * Os números estão em faixas, e a divisão não é decorativa: **Hoje** muda ao longo do
 * dia e é o que a recepção olha de manhã; **Esta semana** é a janela móvel dos últimos
 * 7 dias, que só se mexe uma vez por dia; **Sua base** só muda quando alguém cadastra
 * ou cobra alguém. Misturar as três faria o dono não saber quais números vale atualizar
 * a página para reler.
 *
 * Nenhum número é calculado a partir de listagem — `total` é o que o serviço já sabe
 * responder, e um contador próprio divergiria na primeira exclusão. Cada bloco cai para
 * `null` sozinho: um serviço fora do ar apaga o número dele, não a tela toda. E cada
 * cartão respeita a permissão do módulo — um banhista não vê contas a receber.
 *
 * Embaixo, o roadmap com o que os PRDs especificaram e ainda não tem quem responda.
 *
 * É a única tela com a atmosfera do design ligada. Ela custa nada e dá identidade ao
 * ponto de entrada; repetida nas telas de trabalho passaria a disputar atenção com o dado.
 */

export const dynamic = 'force-dynamic'

interface Stat {
  label: string
  /** `null` quando o serviço que responde por este número não respondeu. */
  value: string | null
  hint: string
  icon: ReactNode
  /**
   * Família de cor do chip: diz de que assunto o cartão trata. É informação diferente
   * de `tone`, logo abaixo — o chip diz o tipo, o número diz o estado. Um cartão de
   * dinheiro é verde mesmo quando o valor está vencido e sai em vermelho.
   */
  iconTone: IconTone
  href?: '/tutores' | '/pets' | '/agenda/dia' | '/financeiro/configuracoes'
  /** Destaca o número quando ele pede ação — dívida vencida, dia lotado. */
  tone?: 'danger'
}

export default async function DashboardPage() {
  const me = await serverApi().me()

  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  const tenant = me.currentTenant
  const can = (permission: string): boolean => me.permissions.includes(permission)

  const settings = await serverApi()
    .getSettings()
    .catch(() => null)
  const timezone = settings?.timezone ?? 'America/Sao_Paulo'
  // "Hoje" é o dia do estabelecimento, não o do servidor: um petshop em Rio Branco
  // veria a agenda do dia seguinte a partir das 21h se isto viesse de UTC.
  const hoje = todayIn(timezone)

  /*
   * `limit: 1` porque só o `total` interessa. Ativos e inativos vêm em chamadas
   * separadas porque a listagem sem filtro devolve os dois somados (e some com os
   * terminais: MERGED, ANONYMIZED, falecido, transferido).
   *
   * A agenda e o financeiro só são consultados por quem pode vê-los — pedir e receber
   * 403 funcionaria, mas gastaria a viagem e sujaria o log de segurança todo dia.
   */
  // Janela móvel dos últimos 7 dias (inclui hoje) — as métricas semanais do MOD-AGENDA
  // não têm reset de segunda-feira no PRD, e uma janela móvel evita o cartão zerar
  // toda manhã de segunda.
  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  // 90 dias sem `last_attendance_at` é o corte de "reativar" do MOD-CRM (tutores_02).
  const noventaDiasAtras = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const [
    activeTutors,
    inactiveTutors,
    tutorsToReactivate,
    activePets,
    inactivePets,
    dayView,
    weekAppointments,
    receivables,
    cashflow,
  ] = await Promise.all([
    countOf(() => serverApi().listTutors({ status: 'ACTIVE', limit: 1 })),
    countOf(() => serverApi().listTutors({ status: 'INACTIVE', limit: 1 })),
    countOf(() =>
      serverApi().listTutors({ status: 'ACTIVE', inactiveSince: noventaDiasAtras, limit: 1 }),
    ),
    countOf(() => serverApi().listPets({ status: 'ACTIVE', limit: 1 })),
    countOf(() => serverApi().listPets({ status: 'INACTIVE', limit: 1 })),
    can('schedule:read_all')
      ? serverApi()
          .getDayView(hoje)
          .catch(() => null)
      : Promise.resolve(null),
    can('schedule:read_all')
      ? serverApi()
          .listAppointments({ from: seteDiasAtras.toISOString(), to: new Date().toISOString() })
          .catch(() => null)
      : Promise.resolve(null),
    can('finance:read')
      ? serverApi()
          .getReceivables()
          .catch(() => null)
      : Promise.resolve(null),
    // O caixa do dia é do gestor: a recepção registra o pagamento, mas o faturamento
    // do estabelecimento não é informação de balcão (§9).
    can('finance:configure')
      ? serverApi()
          .getCashflow()
          .catch(() => null)
      : Promise.resolve(null),
  ])

  const day = dayView ? summarizeDay(dayView) : null
  const week = weekAppointments ? summarizeWeek(weekAppointments) : null

  const hoje_: Stat[] = []
  if (can('schedule:read_all')) {
    hoje_.push(
      {
        label: 'Atendimentos hoje',
        value: day === null ? null : String(day.total),
        hint:
          day === null
            ? 'A agenda não respondeu agora.'
            : day.total === 0
              ? 'Nenhum agendamento para hoje.'
              : `${day.done} concluído${day.done === 1 ? '' : 's'}, ${day.pending} pela frente.`,
        icon: <CalendarIcon />,
        iconTone: 'icon-time',
        href: '/agenda/dia',
      },
      {
        label: 'Ocupação de hoje',
        value: day === null ? null : `${day.occupancy}%`,
        hint:
          day === null
            ? 'A agenda não respondeu agora.'
            : day.workingColumns === 0
              ? 'Ninguém com jornada hoje.'
              : `Das horas de jornada de ${day.workingColumns} profissiona${day.workingColumns === 1 ? 'l' : 'is'}. Diz se falta cliente ou falta gente.`,
        icon: <TrendingUpIcon />,
        iconTone: 'icon-metric',
        href: '/agenda/dia',
      },
    )
  }
  if (cashflow) {
    hoje_.push({
      label: 'Recebido hoje',
      value: formatBRL(cashflow.totalCents),
      hint:
        cashflow.paymentsCount === 0
          ? 'Nenhum pagamento registrado hoje.'
          : `${cashflow.paymentsCount} pagamento${cashflow.paymentsCount === 1 ? '' : 's'}${topMethod(cashflow.byMethod)}.`,
      icon: <WalletIcon />,
      iconTone: 'icon-money',
      href: '/financeiro/configuracoes',
    })
  }

  // Os três indicadores que o roadmap prometia para MOD-AGENDA (agenda_operacao_06.md)
  // e que o `AppointmentResponse` já carrega: `status`, `cancelledLate`, `checkinAt` e
  // `checkoutAt` vêm de uma única listagem de 7 dias, sem endpoint novo.
  const semana_: Stat[] = []
  if (can('schedule:read_all')) {
    semana_.push(
      {
        label: 'Faltas na semana',
        value:
          week === null ? null : week.real === 0 ? '—' : `${Math.round((week.noShow / week.real) * 100)}%`,
        hint:
          week === null
            ? 'A agenda não respondeu agora.'
            : week.real === 0
              ? 'Nenhum atendimento nos últimos 7 dias.'
              : `${week.noShow} falta${week.noShow === 1 ? '' : 's'} de ${week.real} agendamentos.`,
        icon: <CalendarIcon />,
        iconTone: 'icon-time',
        href: '/agenda/dia',
      },
      {
        label: 'Cancelamentos em cima da hora',
        value: week === null ? null : String(week.cancelledLate),
        hint:
          week === null
            ? 'A agenda não respondeu agora.'
            : week.cancelled === 0
              ? 'Nenhum cancelamento nos últimos 7 dias.'
              : `${week.cancelledLate} de ${week.cancelled} cancelamento${week.cancelled === 1 ? '' : 's'} vieram dentro da janela de 24h.`,
        icon: <TrendingUpIcon />,
        iconTone: 'icon-metric',
        href: '/agenda/dia',
      },
      {
        label: 'Pontualidade',
        value:
          week === null
            ? null
            : week.avgArrivalDelayMin === null
              ? '—'
              : `${week.avgArrivalDelayMin > 0 ? '+' : ''}${week.avgArrivalDelayMin} min`,
        hint:
          week === null
            ? 'A agenda não respondeu agora.'
            : week.avgArrivalDelayMin === null
              ? 'Nenhum check-in nos últimos 7 dias.'
              : `Chegada em relação ao horário marcado${durationHint(week.avgDurationDeltaMin)}.`,
        icon: <CalendarIcon />,
        iconTone: 'icon-time',
        href: '/agenda/dia',
      },
    )
  }

  const base: Stat[] = [
    {
      label: 'Tutores ativos',
      value: format(activeTutors),
      hint:
        activeTutors === null
          ? 'Contagem indisponível agora.'
          : inactiveTutors
            ? `Mais ${format(inactiveTutors)} na carteira, marcados como inativos.`
            : 'Quem responde pelos animais e recebe os lançamentos.',
      icon: <UsersIcon />,
      iconTone: 'icon-people',
      href: '/tutores',
    },
    {
      label: 'Pets ativos',
      value: format(activePets),
      // `pet_per_tutor_avg` do PRD de pets virou a dica deste cartão: é indicador de
      // ticket potencial, mas é razão entre dois números que já estão nesta faixa —
      // como cartão próprio, ocupava o lugar de algo em que se pode agir.
      hint: petsHint(activePets, inactivePets, activeTutors, inactiveTutors),
      icon: <PawPrintIcon />,
      iconTone: 'icon-pet',
      href: '/pets',
    },
    {
      label: 'Tutores para reativar',
      value: format(tutorsToReactivate),
      hint:
        tutorsToReactivate === null
          ? 'Contagem indisponível agora.'
          : tutorsToReactivate === 0
            ? 'Ninguém sem visita há mais de 90 dias.'
            : 'Ativos, mas sem visita registrada nos últimos 90 dias.',
      icon: <UsersIcon />,
      iconTone: 'icon-people',
      href: '/tutores',
    },
  ]
  if (receivables) {
    const overdue = receivables.buckets['30_60d'] + receivables.buckets['60d_plus']
    base.push({
      label: 'Em aberto',
      value: formatBRL(receivables.totalCents),
      hint:
        receivables.totalCents === 0
          ? 'Nenhum débito em aberto na carteira.'
          : overdue > 0
            ? `${formatBRL(overdue)} vencidos há mais de 30 dias.`
            : 'Tudo dentro do prazo de 30 dias.',
      icon: <WalletIcon />,
      iconTone: 'icon-money',
      href: '/financeiro/configuracoes',
      ...(overdue > 0 ? { tone: 'danger' as const } : {}),
    })
  }

  return (
    <AppShell active="inicio" me={me} atmosphere>
      <div className="mx-auto max-w-5xl">
        {/*
          Título 1 · Display do modelo de design, sem o peso 600: mesma Inter, mesmo
          `leading 1.02` e `tracking −0.035em`, em 45px — três pontos abaixo dos 3rem
          do degrau base. O tracking negativo é o que sustenta a hierarquia aqui; sem
          o peso, é ele que impede o nome de ler como parágrafo grande.
        */}
        <h1 className="text-[45px] leading-[1.02] tracking-[-0.035em] text-ink-soft">
          {tenant.name}
        </h1>
        {/* Título 4 · Card padrão do design: 1.125rem / 1.75rem, peso 600. */}
        <p className="mt-2 text-lg font-semibold">
          {greetingFor(timezone)}, {firstNameOf(me.user.fullName)}.
        </p>

        {hoje_.length > 0 && <StatSection title="Hoje" stats={hoje_} />}
        {semana_.length > 0 && <StatSection title="Esta semana" stats={semana_} />}
        <StatSection title="Sua base" stats={base} />

        <Roadmap permissions={me.permissions} />
      </div>
    </AppShell>
  )
}

/**
 * Uma faixa de cartões com título visível.
 *
 * O título saiu do `sr-only` quando passou a haver duas faixas: com uma só, ele era
 * ruído; com duas, é ele que diz por que os números estão separados.
 */
function StatSection({ title, stats }: { title: string; stats: Stat[] }) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium uppercase tracking-[0.06em] text-subtle">{title}</h2>

      <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => {
          const body = (
            <>
              <CardBloom />

              {/* O conteúdo sobe acima do bloom pelo mesmo motivo do shell. */}
              <div className="relative z-10">
                <span className={`icon-chip ${stat.iconTone}`}>{stat.icon}</span>
                <p
                  className={`mt-5 text-4xl font-semibold tabular-nums ${
                    stat.tone === 'danger' ? 'text-danger' : ''
                  }`}
                >
                  {stat.value ?? <span className="text-subtle">—</span>}
                </p>
                <p className="mt-1 text-lg font-semibold">{stat.label}</p>
                <p className="mt-3 text-sm leading-relaxed text-muted">{stat.hint}</p>
              </div>
            </>
          )

          // Só vira link o cartão que tem para onde levar: um cartão clicável que não
          // navega é pior que um cartão parado.
          return stat.href ? (
            <Link
              key={stat.label}
              href={stat.href}
              className="card card-interactive relative overflow-hidden p-7"
            >
              {body}
            </Link>
          ) : (
            <div key={stat.label} className="card relative overflow-hidden p-7">
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
}

interface DaySummary {
  total: number
  done: number
  pending: number
  occupancy: number
  workingColumns: number
}

/**
 * O dia em quatro números.
 *
 * A ocupação é a **média das colunas de quem trabalha hoje** — quem está de folga ou
 * sem jornada fica de fora. Incluir os ausentes com 0% faria o dia parecer vazio toda
 * vez que alguém tirasse férias, que é o oposto do que o número existe para dizer.
 *
 * Cancelados e faltas não contam como atendimento: o cartão responde "quanto trabalho
 * há hoje", não "quantas linhas existem no banco".
 */
function summarizeDay(dayView: DayView): DaySummary {
  const working = dayView.columns.filter((column) => !column.absent && column.shifts.length > 0)

  const appointments = dayView.columns.flatMap((column) => column.appointments)
  const real = appointments.filter(
    (appointment) => appointment.status !== 'CANCELLED' && appointment.status !== 'RESCHEDULED',
  )
  const done = real.filter((appointment) => appointment.status === 'COMPLETED').length
  const noShow = real.filter((appointment) => appointment.status === 'NO_SHOW').length

  const occupancy =
    working.length === 0
      ? 0
      : Math.round(
          working.reduce((sum, column) => sum + column.occupancyPercent, 0) / working.length,
        )

  return {
    total: real.length,
    done,
    // A falta já não vai acontecer: contá-la como "pela frente" mandaria a recepção
    // esperar por alguém que não vem.
    pending: real.length - done - noShow,
    occupancy,
    workingColumns: working.length,
  }
}

interface WeekSummary {
  /** Excluídos cancelamento e remarcação — mesma régua de `summarizeDay`. */
  real: number
  noShow: number
  cancelled: number
  /** RN-06: dentro da janela de 24h da política. */
  cancelledLate: number
  /** Minutos entre `checkinAt` e `startsAt`, média de quem chegou. `null` sem check-in. */
  avgArrivalDelayMin: number | null
  /** Minutos de diferença entre a duração real (`checkoutAt` − `checkinAt`) e a
   *  prevista (`endsAt` − `startsAt`), média de quem fechou o atendimento. */
  avgDurationDeltaMin: number | null
}

/**
 * Os últimos 7 dias em seis números — os três indicadores que `Roadmap` prometia
 * para MOD-AGENDA, agora que `AppointmentResponse` já carrega `cancelledLate`,
 * `checkinAt` e `checkoutAt` (agenda_operacao_06.md).
 */
function summarizeWeek(appointments: AppointmentResponse[]): WeekSummary {
  const real = appointments.filter(
    (appointment) => appointment.status !== 'CANCELLED' && appointment.status !== 'RESCHEDULED',
  )
  const noShow = real.filter((appointment) => appointment.status === 'NO_SHOW').length

  const cancelled = appointments.filter((appointment) => appointment.status === 'CANCELLED')
  const cancelledLate = cancelled.filter((appointment) => appointment.cancelledLate === true).length

  const arrived = real.filter((appointment) => appointment.checkinAt !== null)
  const avgArrivalDelayMin =
    arrived.length === 0 ? null : Math.round(average(arrived.map(arrivalDelayMin)))

  const finished = real.filter(
    (appointment) => appointment.checkinAt !== null && appointment.checkoutAt !== null,
  )
  const avgDurationDeltaMin =
    finished.length === 0 ? null : Math.round(average(finished.map(durationDeltaMin)))

  return {
    real: real.length,
    noShow,
    cancelled: cancelled.length,
    cancelledLate,
    avgArrivalDelayMin,
    avgDurationDeltaMin,
  }
}

function arrivalDelayMin(appointment: AppointmentResponse): number {
  return (
    (new Date(appointment.checkinAt as string).getTime() - new Date(appointment.startsAt).getTime()) /
    60_000
  )
}

function durationDeltaMin(appointment: AppointmentResponse): number {
  const realMin =
    (new Date(appointment.checkoutAt as string).getTime() -
      new Date(appointment.checkinAt as string).getTime()) /
    60_000
  const plannedMin =
    (new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000
  return realMin - plannedMin
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Completa a dica de pontualidade com a duração real, só quando há dado para ela. */
function durationHint(avgDurationDeltaMin: number | null): string {
  if (avgDurationDeltaMin === null) return ''
  if (Math.abs(avgDurationDeltaMin) < 1) return '. Duração bate com a prevista'
  const sinal = avgDurationDeltaMin > 0 ? 'a mais' : 'a menos'
  return `. Atendimentos duram, em média, ${Math.abs(avgDurationDeltaMin)} min ${sinal} que o previsto`
}

/** A forma de pagamento que mais entrou hoje — a "realidade do balcão" do §10. */
function topMethod(byMethod: { method: string; totalCents: number }[]): string {
  const top = byMethod[0]
  if (!top || byMethod.length === 0) return ''

  const labels: Record<string, string> = {
    CASH: 'dinheiro',
    PIX_MANUAL: 'PIX',
    CARD_MACHINE_DEBIT: 'débito',
    CARD_MACHINE_CREDIT: 'crédito',
    BANK_TRANSFER: 'transferência',
    PACKAGE_CREDIT: 'crédito de pacote',
    OTHER: 'outros',
  }
  return `, a maior parte em ${labels[top.method] ?? 'outros'}`
}

/** Total de uma listagem paginada, ou `null` se o serviço não respondeu. */
async function countOf(fetchPage: () => Promise<{ total: number }>): Promise<number | null> {
  return fetchPage()
    .then((page) => page.total)
    .catch(() => null)
}

/** Separador de milhar brasileiro: 1.240, não 1240. */
function format(value: number | null): string | null {
  return value === null ? null : value.toLocaleString('pt-BR')
}

/**
 * A dica do cartão de pets: quantos inativos, e a média por tutor.
 *
 * A média só entra se as quatro contagens vieram — com uma faltando, seria razão entre
 * bases diferentes, e um número errado é pior que a frase sem ele.
 */
function petsHint(
  activePets: number | null,
  inactivePets: number | null,
  activeTutors: number | null,
  inactiveTutors: number | null,
): string {
  if (activePets === null) return 'Contagem indisponível agora.'

  const partes: string[] = []
  if (inactivePets) partes.push(`Mais ${format(inactivePets)} sem visita recente`)

  const media = petsPerTutor(activePets, inactivePets, activeTutors, inactiveTutors)
  if (media) partes.push(`média de ${media} por tutor`)

  if (partes.length === 0) return 'Os animais atendidos, com espécie, porte e responsáveis.'
  return `${partes.join(' · ')}.`
}

/** `pet_per_tutor_avg` do PRD de pets: indicador de ticket potencial. */
function petsPerTutor(
  activePets: number | null,
  inactivePets: number | null,
  activeTutors: number | null,
  inactiveTutors: number | null,
): string | null {
  if (activePets === null || inactivePets === null) return null
  if (activeTutors === null || inactiveTutors === null) return null

  const tutors = activeTutors + inactiveTutors
  if (tutors === 0) return null

  return ((activePets + inactivePets) / tutors).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
}

/**
 * Saudação pelo fuso do estabelecimento, não pelo do servidor.
 *
 * O petshop de Rio Branco abre às 8h locais; renderizar "boa tarde" porque o Node
 * roda em UTC seria errado de um jeito que o dono nota todo dia.
 */
function greetingFor(timezone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('pt-BR', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(new Date()),
  )

  if (hour < 12) return 'Bom dia'
  if (hour < 18) return 'Boa tarde'
  return 'Boa noite'
}

/** Só o primeiro nome: é assim que se cumprimenta alguém no balcão. */
function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName
}
