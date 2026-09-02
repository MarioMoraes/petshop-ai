import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { formatBRL, todayIn } from '@petshop/shared-types'
import { AppShell } from '@/components/app-shell'
import { CardBloom } from '@/components/atmosphere'
import {
  PawPrintIcon,
  UsersIcon,
  WalletIcon,
  WaveIcon,
  type IconTone,
} from '@/components/icons'
import { serverApi } from '@/lib/api'
import { MovementChart } from './movement-chart'
import { Roadmap } from './roadmap'

/**
 * Início — o painel do estabelecimento.
 *
 * Já foi um checklist de onboarding ("cadastre seu primeiro tutor", "convide sua
 * equipe"). Não é mais: terminar a configuração e continuar sendo cobrado por tarefas
 * faz o produto parecer que nunca começou. O que fica é o estado do negócio.
 *
 * Os números estão em faixas, e a divisão não é decorativa: **Movimento** é o que se
 * acompanha — muda ao longo do dia e é onde há o que fazer hoje; **Sua base** é o
 * cadastro, e só muda quando alguém entra ou sai da carteira. Misturar as duas faria o
 * dono não saber quais números vale atualizar a página para reler.
 *
 * O Movimento abre com o gráfico dos últimos sete dias, e não com o número de hoje: o
 * dia isolado não diz se está bom ou ruim, só a série diz. Ver `movement-chart.tsx`.
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
  const [activeTutors, inactiveTutors, activePets, inactivePets, movement, receivables, cashflow] =
    await Promise.all([
    countOf(() => serverApi().listTutors({ status: 'ACTIVE', limit: 1 })),
    countOf(() => serverApi().listTutors({ status: 'INACTIVE', limit: 1 })),
    countOf(() => serverApi().listPets({ status: 'ACTIVE', limit: 1 })),
    countOf(() => serverApi().listPets({ status: 'INACTIVE', limit: 1 })),
    // A série é contada pelo serviço, não somada a partir de uma listagem: a listagem
    // de agendamentos corta em 200 linhas e a semana de um petshop cheio passaria.
    can('schedule:read_all')
      ? serverApi()
          .getMovement({ date: hoje, days: 7 })
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

  /*
   * A faixa era três cartões: atendimentos de hoje, ocupação de hoje e caixa. Os dois
   * primeiros saíram — o gráfico dos sete dias responde melhor à mesma pergunta, e o
   * número do dia sozinho só dizia alguma coisa depois de o dono lembrar como foi a
   * semana. Quem quer o dia inteiro clica no cartão e cai na agenda, que é onde ele
   * está de verdade.
   */
  const fluxo: Stat[] = []
  if (cashflow) {
    fluxo.push({
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

  if (receivables) {
    const overdue = receivables.buckets['30_60d'] + receivables.buckets['60d_plus']
    /*
     * A dívida em aberto está nesta faixa, e não em "Sua base", apesar de ser saldo
     * acumulado e não fluxo do dia. É o número da tela em que mais se pode agir hoje:
     * ao lado de tutores e pets ele lia como cadastro, e ninguém cobra ninguém depois
     * de olhar um cadastro.
     */
    fluxo.push({
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
  ]
  return (
    <AppShell active="inicio" me={me} atmosphere>
      <div className="mx-auto max-w-5xl">
        {/*
          A saudação é o título da página.

          O nome do estabelecimento vinha aqui em 45px e saiu: ele já está na topbar,
          no seletor de estabelecimento, e repeti-lo logo abaixo fazia o Início abrir
          dizendo duas vezes onde a pessoa está antes de dizer qualquer coisa que ela
          possa usar. Sem ele, quem herda o `<h1>` é a saudação — que é o que a tela
          realmente diz ao abrir.
        */}
        <h1 className="flex items-center gap-2 text-[22px] leading-8 font-semibold">
          {greetingFor(timezone)}, {firstNameOf(me.user.fullName)}.
          {/*
            O aceno é decoração, não informação: `aria-hidden` no traçado (herdado de
            `BASE`) mantém o leitor de tela lendo só a frase. A inclinação é o que faz a
            mão aberta ler como aceno em vez de "pare"; o acento é a única cor quente
            do sistema, e uma saudação é o lugar dela.
          */}
          <span className="inline-flex rotate-12 text-accent">
            <WaveIcon />
          </span>
        </h1>

        {(movement !== null || fluxo.length > 0) && (
          <StatSection
            title="Movimento"
            stats={fluxo}
            lead={
              movement && (
                <Link
                  href="/agenda/dia"
                  className="card card-interactive relative block overflow-hidden p-6"
                >
                  <CardBloom />
                  <MovementChart days={movement.days} today={hoje} />
                </Link>
              )
            }
          />
        )}
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
 *
 * `lead` é o primeiro cartão da grade — hoje, o gráfico dos sete dias. Entra como
 * `ReactNode` e não como `Stat` porque o corpo dele não é "número, rótulo, dica": é o
 * molde de métrica do design, com as barras no meio. Mesma casca, conteúdo próprio.
 */
function StatSection({
  title,
  stats,
  lead,
}: {
  title: string
  stats: Stat[]
  lead?: ReactNode
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium uppercase tracking-[0.06em] text-subtle">{title}</h2>

      <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {lead}

        {stats.map((stat) => {
          const body = (
            <>
              <CardBloom />

              {/* O conteúdo sobe acima do bloom pelo mesmo motivo do shell. */}
              <div className="relative z-10">
                {/*
                  Molde vertical da Composição 2 do `design/design-modelo.html` — chip,
                  figura, rótulo, dica —, em escala menor. O que encolheu foi o tamanho
                  de cada peça, não a ordem delas: o chip cai de 48 para 36px, a figura
                  de 36 para 30, o rótulo de 18 para 16, e o rótulo volta a ficar colado
                  na figura, como no modelo.

                  O cartão do gráfico, ao lado, usa o cabeçalho em linha: ele é o mais
                  alto da fileira e todos os outros esticam até ele, então é dele que sai
                  a altura da faixa.
                */}
                <span className={`icon-chip icon-chip-sm ${stat.iconTone}`}>{stat.icon}</span>
                <p
                  className={`mt-4 text-3xl font-semibold tabular-nums ${
                    stat.tone === 'danger' ? 'text-danger' : ''
                  }`}
                >
                  {stat.value ?? <span className="text-subtle">—</span>}
                </p>
                <p className="text-base font-semibold">{stat.label}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted">{stat.hint}</p>
              </div>
            </>
          )

          // Só vira link o cartão que tem para onde levar: um cartão clicável que não
          // navega é pior que um cartão parado.
          return stat.href ? (
            <Link
              key={stat.label}
              href={stat.href}
              className="card card-interactive relative overflow-hidden p-6"
            >
              {body}
            </Link>
          ) : (
            <div key={stat.label} className="card relative overflow-hidden p-6">
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
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
