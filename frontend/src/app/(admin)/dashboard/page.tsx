import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import {
  TAXI_FAILURE_REASON_LABELS,
  formatBRL,
  todayIn,
  type BookingSources,
  type PortalAdoption,
  type TaxiOperationReport,
} from '@petshop/shared-types'
import { AppShell } from '@/components/app-shell'
import { CardBloom } from '@/components/atmosphere'
import {
  PawPrintIcon,
  SmartphoneIcon,
  UsersIcon,
  VanIcon,
  WalletIcon,
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

/**
 * A janela das duas faixas de baixo.
 *
 * Trinta dias, e não sete como o gráfico: aderência, funil e adoção são proporções, e
 * uma semana de um petshop médio não tem corrida nem vínculo em número que sustente
 * uma porcentagem — a barra do gráfico sobrevive a um dia fraco, o percentual não.
 */
const REPORT_DAYS = 30

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
  href?: '/tutores' | '/pets' | '/agenda/dia' | '/financeiro/configuracoes' | '/taxi'
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
  const [
    activeTutors,
    inactiveTutors,
    activePets,
    inactivePets,
    movement,
    receivables,
    cashflow,
    taxi,
    bookingSources,
    portal,
  ] = await Promise.all([
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
    /*
     * As três leituras de baixo caem para `null` também quando o **módulo** está
     * desligado, e não só quando o serviço não respondeu: o relatório do Taxi recusa
     * com o módulo desligado (RN-22), e a faixa inteira some. É de propósito — "0% de
     * aderência" é um resultado ruim, e não fazer leva-e-traz não é resultado nenhum.
     */
    can('taxi:configure')
      ? serverApi()
          .getTaxiOperationReport({ days: REPORT_DAYS })
          .catch(() => null)
      : Promise.resolve(null),
    // A adoção do Portal é pergunta de quem o ligou, e o gate é o mesmo interruptor.
    can('tenant:configure')
      ? serverApi()
          .getBookingSources({ days: REPORT_DAYS })
          .catch(() => null)
      : Promise.resolve(null),
    can('tenant:configure')
      ? serverApi()
          .getPortalAdoption({ days: REPORT_DAYS })
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
  const taxiStats = taxi ? taxiCards(taxi) : []
  const portalStats = portalCards(bookingSources, portal)

  return (
    <AppShell active="inicio" me={me} atmosphere>
      <div className="mx-auto max-w-5xl">
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

        {taxiStats.length > 0 && (
          <StatSection title="Taxi Dog" note={`Últimos ${REPORT_DAYS} dias`} stats={taxiStats} />
        )}
        {portalStats.length > 0 && (
          <StatSection
            title="Portal do tutor"
            note={`Últimos ${REPORT_DAYS} dias`}
            stats={portalStats}
          />
        )}

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
 *
 * `note` diz o período, e existe para as faixas que olham para trás. Fica no título e
 * não nas dicas: repetido em cada cartão, "nos últimos 30 dias" seria a mesma frase
 * três vezes ocupando o lugar do que cada número tem de próprio a dizer.
 */
function StatSection({
  title,
  note,
  stats,
  lead,
}: {
  title: string
  note?: string
  stats: Stat[]
  lead?: ReactNode
}) {
  return (
    // `first:mt-0`: com a saudação na topbar, a primeira faixa encosta no `pt` do
    // conteúdo — somar a margem daria ao Início um vão de abertura sem nada dentro.
    <section className="mt-8 first:mt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-[0.06em] text-subtle">{title}</h2>
        {note && <p className="hint">{note}</p>}
      </div>

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

/**
 * A faixa do Taxi Dog: a promessa cumprida, o que a quebrou e onde ela foi mal feita.
 *
 * Os três números são a mesma pergunta em profundidades diferentes — se a janela está
 * sendo cumprida, por que não, e em que zona ela nasceu apertada demais. Por isso vêm
 * juntos: a aderência sozinha diz que há um problema e não deixa fazer nada com ele.
 *
 * Nenhum deles sai em vermelho, ao contrário da dívida vencida lá em cima. Marcar
 * exigiria um limite — 80%? 90%? —, e o PRD não fixa nenhum. Um número inventado aqui
 * viraria meta do petshop na primeira semana.
 */
function taxiCards(report: TaxiOperationReport): Stat[] {
  const pior = report.legsByZone[0]

  return [
    {
      label: 'Aderência à janela',
      value: report.adherenceRate === null ? null : formatPercent(report.adherenceRate),
      hint:
        report.adherenceRate === null
          ? 'Nenhuma corrida entregue no período.'
          : `${report.onTime} de ${report.delivered} entregues dentro da janela prometida.`,
      icon: <VanIcon />,
      iconTone: 'icon-time',
      href: '/taxi',
    },
    {
      label: 'Corridas que falharam',
      value: format(report.failed),
      hint: failuresHint(report),
      icon: <VanIcon />,
      iconTone: 'icon-time',
      href: '/taxi',
    },
    {
      label: 'Tempo médio de perna',
      value: report.averageLegMinutes === null ? null : `${formatDecimal(report.averageLegMinutes)} min`,
      hint:
        report.averageLegMinutes === null
          ? 'Sem corrida entregue com hora de saída registrada.'
          : pior && report.legsByZone.length > 1
            ? `Da saída da van à entrega. A mais lenta é ${pior.zoneName}, com ${formatDecimal(pior.averageMinutes)} min.`
            : 'Da saída da van até a entrega — é o que dimensiona a janela padrão.',
      icon: <VanIcon />,
      iconTone: 'icon-time',
      href: '/taxi',
    },
  ]
}

/** O motivo que mais custou corrida no período — mesmo molde da forma de pagamento. */
function failuresHint(report: TaxiOperationReport): string {
  if (report.failed === 0) return 'Nenhuma corrida falhou no período.'

  const top = report.failuresByReason[0]
  if (!top) return 'Sem motivo registrado.'

  return `A maior parte por "${TAXI_FAILURE_REASON_LABELS[top.reason].toLowerCase()}".`
}

/**
 * A faixa do Portal: quanto o tutor está se servindo sozinho, e por que não mais.
 *
 * Os dois lados vêm de serviços diferentes — a fatia de agendamentos do
 * scheduling-service, o funil e o retorno do tutor-service — e cada um entra sozinho.
 * Um serviço fora do ar tira o cartão dele, e não a faixa: dos três, dois ainda
 * respondem a pergunta.
 */
function portalCards(sources: BookingSources | null, adoption: PortalAdoption | null): Stat[] {
  const cards: Stat[] = []

  if (sources) {
    cards.push({
      label: 'Agendamentos pelo Portal',
      value: sources.total === 0 ? null : formatPercent(sources.portal / sources.total),
      hint:
        sources.total === 0
          ? 'Nenhum agendamento marcado no período.'
          : `${sources.portal} de ${sources.total} marcados pelo próprio tutor, sem passar pelo balcão.`,
      icon: <SmartphoneIcon />,
      iconTone: 'icon-people',
    })
  }

  if (adoption) {
    const { requested, completed } = adoption.linking

    cards.push({
      label: 'Vínculos concluídos',
      value: requested === 0 ? null : formatPercent(completed / requested),
      hint:
        requested === 0
          ? 'Ninguém pediu código de acesso no período.'
          : `${completed} de ${requested} pedidos de código chegaram ao fim.`,
      icon: <SmartphoneIcon />,
      iconTone: 'icon-people',
    })

    cards.push({
      label: 'Tutores que voltaram',
      value: format(adoption.tutors.active),
      hint:
        adoption.tutors.total === 0
          ? 'Nenhum tutor ativo na carteira.'
          : `${formatPercent(adoption.tutors.active / adoption.tutors.total)} da carteira ativa abriu o Portal.`,
      icon: <SmartphoneIcon />,
      iconTone: 'icon-people',
    })
  }

  return cards
}

/** Sem casas decimais: "34%". A precisão de uma proporção de painel acaba aí. */
function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100).toLocaleString('pt-BR')}%`
}

/** Uma casa, com vírgula: 22,4 — e "22" quando o decimal é zero. */
function formatDecimal(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
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

