import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  DEFAULT_TIMEZONE,
  formatBRL,
  todayIn,
  type CriticalPets,
  type FinanceIndicators,
  type NoShowReport,
  type PortfolioQuality,
} from '@petshop/shared-types'
import { CardBloom } from '@/components/atmosphere'
import {
  HeartPulseIcon,
  PawPrintIcon,
  UsersIcon,
  WalletIcon,
  type IconTone,
} from '@/components/icons'
import { carregarMe, serverApi } from '@/lib/api'
import { MovementChart } from './movement-chart'
import { STAT_GRID, STAT_MIN_HEIGHT } from './stat-grid'

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
 * O roadmap do que os PRDs pedem e ainda não tem dado ("Em breve") saiu em 2026-09-15, a
 * pedido: o painel mostra o que responde. Os três indicadores que esperam o dado ser
 * gravado — vacinas atrasadas, bloqueios por alergia e bloqueios do self-service do
 * Portal — voltam como cartão quando existirem, e não como promessa. As faixas do Taxi Dog
 * e do Portal do tutor saíram em 2026-10-03, também a pedido; os relatórios do backend
 * que as alimentavam continuam de pé.
 *
 * **A grade é de três, e toda faixa fecha a linha.** Cartão de número tem altura mínima
 * própria (`STAT_MIN_HEIGHT`), para que a régua seja a mesma de uma faixa para a outra e
 * não a do cartão mais alto de cada linha; e a dica é escrita para caber em duas linhas
 * na coluna de um terço. Dica que precisa de três está dizendo demais para um cartão.
 *
 * É a única tela com a atmosfera do design ligada. Ela custa nada e dá identidade ao
 * ponto de entrada; repetida nas telas de trabalho passaria a disputar atenção com o dado.
 */

export const dynamic = 'force-dynamic'

/**
 * A janela da faixa do Financeiro.
 *
 * Trinta dias, e não sete como o gráfico: os indicadores são médias e proporções, e uma
 * semana de um petshop médio não tem movimento que as sustente — a barra do gráfico
 * sobrevive a um dia fraco, o percentual não.
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
  href?:
    '/tutores' | '/pets' | '/agenda/dia' | '/financeiro/configuracoes' | '/configuracoes/pacotes'
  /** Destaca o número quando ele pede ação — dívida vencida, dia lotado. */
  tone?: 'danger'
}

export default async function DashboardPage() {
  // O gate de onboarding e a moldura ficam no layout, como nas demais seções.
  const me = await carregarMe()

  const can = (permission: string): boolean => me.permissions.includes(permission)

  // Só a multa de falta sai das configurações, e só a faixa do Financeiro a mostra: pedir
  // a quem não tem `tenant:read_settings` era um 403 e uma negação na trilha por visita.
  const settings = can('tenant:read_settings')
    ? await serverApi()
        .getSettings()
        .catch(() => null)
    : null
  const timezone = me.timezone ?? DEFAULT_TIMEZONE
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
    portfolio,
    critical,
    finance,
    noShows,
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
    // O preenchimento da carteira é de quem vê a carteira — o mesmo gate da contagem.
    can('tutor:read')
      ? serverApi()
          .getPortfolioQuality()
          .catch(() => null)
      : Promise.resolve(null),
    /*
     * `record:read_summary`, e não o `record:read_alerts` que todo mundo tem: o alerta
     * de um pet é de quem encosta nele, a contagem da casa é leitura de gestão.
     */
    can('record:read_summary')
      ? serverApi()
          .getCriticalPets()
          .catch(() => null)
      : Promise.resolve(null),
    can('finance:configure')
      ? serverApi()
          .getFinanceIndicators({ days: REPORT_DAYS })
          .catch(() => null)
      : Promise.resolve(null),
    // As faltas servem para decidir ligar a multa, e quem liga é quem configura a casa.
    can('tenant:configure')
      ? serverApi()
          .getNoShows({ days: REPORT_DAYS })
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
      hint: recebidoHint(cashflow),
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
  /*
   * A ordem fecha duas linhas de três: em cima, quem está na carteira (tutores, pets e os
   * pets que pedem cuidado); embaixo, o quanto essa carteira está preenchida e presa à
   * casa. "Clientes com pacote" mora aqui, e não na faixa do Financeiro, porque é retrato
   * de hoje — lá tudo é dos últimos 30 dias, e o título da faixa diz isso.
   */
  if (critical) base.push(criticalCard(critical))
  if (portfolio) base.push(...portfolioCards(portfolio))
  if (finance) base.push(packagesCard(finance))

  const financeStats = financeCards(finance, noShows, settings?.noShowFeePercent ?? null)

  return (
    <>
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
      {financeStats.length > 0 && (
        <StatSection title="Financeiro" note={`Últimos ${REPORT_DAYS} dias`} stats={financeStats} />
      )}

      <StatSection title="Sua base" stats={base} />
    </>
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

      <div className={`mt-4 ${STAT_GRID}`}>
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
              className={`card card-interactive relative overflow-hidden p-6 ${STAT_MIN_HEIGHT}`}
            >
              {body}
            </Link>
          ) : (
            <div
              key={stat.label}
              className={`card relative overflow-hidden p-6 ${STAT_MIN_HEIGHT}`}
            >
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Os dois números de preenchimento da carteira, na faixa "Sua base".
 *
 * Os dois dividem pelo `active` que veio na mesma resposta, e não pelo "Tutores ativos"
 * do cartão ao lado: aquela contagem é outra chamada, e uma porcentagem entre instantes
 * diferentes pode passar de 100% no dia em que alguém cadastra um tutor entre as duas.
 */
function portfolioCards(portfolio: PortfolioQuality): Stat[] {
  const { active, complete, whatsappMarketing } = portfolio

  return [
    {
      label: 'Cadastros completos',
      value: active === 0 ? null : formatPercent(complete / active),
      hint:
        active === 0
          ? 'Nenhum tutor ativo na carteira.'
          : `${format(complete)} de ${format(active)} tutores ativos com o cadastro completo.`,
      icon: <UsersIcon />,
      iconTone: 'icon-people',
      href: '/tutores',
    },
    {
      label: 'Aceitam WhatsApp',
      value: active === 0 ? null : formatPercent(whatsappMarketing / active),
      hint:
        active === 0
          ? 'Nenhum tutor ativo na carteira.'
          : `${format(whatsappMarketing)} de ${format(active)} autorizaram promoções pelo WhatsApp.`,
      icon: <UsersIcon />,
      iconTone: 'icon-people',
    },
  ]
}

/**
 * Pets com alerta crítico: quantos, e de que origem.
 *
 * Não sai em vermelho. O número não é pendência a zerar — um pet agressivo continua
 * agressivo —, e a cor de perigo nesta faixa é da dívida vencida, que se resolve.
 */
function criticalCard(critical: CriticalPets): Stat {
  const origens = [
    critical.byAllergy > 0 ? `${format(critical.byAllergy)} por alergia` : null,
    critical.byTemperament > 0 ? `${format(critical.byTemperament)} por temperamento` : null,
    critical.byMedical > 0 ? `${format(critical.byMedical)} por condição médica` : null,
  ].filter((origem): origem is string => origem !== null)

  return {
    label: 'Pets com alerta crítico',
    value: format(critical.pets),
    hint: critical.pets === 0 ? 'Nenhum pet com alerta crítico ativo.' : `${origens.join(' · ')}.`,
    icon: <HeartPulseIcon />,
    iconTone: 'icon-pet',
    href: '/pets',
  }
}

/**
 * A faixa do Financeiro: quanto se espera para receber, e o que se perdeu por pacote
 * vencido e por falta — os três olhando para os últimos 30 dias.
 *
 * As duas origens entram sozinhas: os dois primeiros números
 * vêm do financeiro, o das faltas vem da agenda, e um serviço fora do ar tira só o
 * cartão dele.
 *
 * O cartão das faltas não diz "quanto foi cobrado", que é a outra metade do indicador no
 * PRD: a multa é calculada na falta e não vira lançamento, então não há cobrança a
 * somar. O que ele diz no lugar é se a multa está ligada — que é a decisão que o número
 * serve para tomar.
 */
function financeCards(
  finance: FinanceIndicators | null,
  noShows: NoShowReport | null,
  noShowFeePercent: number | null,
): Stat[] {
  const cards: Stat[] = []

  if (finance) {
    const { averageDays, settledCents } = finance.collection
    const { purchases, credits, valueCents } = finance.expired

    cards.push({
      label: 'Prazo médio de recebimento',
      value: averageDays === null ? null : formatDays(averageDays),
      hint:
        averageDays === null
          ? 'Nenhum débito quitado no período.'
          : `Do serviço prestado ao pagamento, sobre ${formatBRL(settledCents)} quitados.`,
      icon: <WalletIcon />,
      iconTone: 'icon-money',
    })

    cards.push({
      label: 'Crédito vencido sem uso',
      value: formatBRL(valueCents),
      hint:
        purchases === 0
          ? 'Nenhum pacote venceu com crédito sobrando.'
          : `${plural(credits, 'crédito perdido', 'créditos perdidos')} em ${plural(purchases, 'pacote', 'pacotes')} — cliente que pagou e não usou.`,
      icon: <WalletIcon />,
      iconTone: 'icon-money',
      href: '/configuracoes/pacotes',
    })
  }

  if (noShows) {
    const multa =
      noShowFeePercent === null
        ? ''
        : noShowFeePercent === 0
          ? ' A multa por falta está desligada.'
          : ` A multa por falta está em ${noShowFeePercent}%.`

    cards.push({
      label: 'Perdido com faltas',
      value: formatBRL(noShows.totalCents),
      hint:
        noShows.count === 0
          ? 'Nenhuma falta no período.'
          : `${plural(noShows.count, 'horário vazio', 'horários vazios')} por falta.${multa}`,
      icon: <WalletIcon />,
      iconTone: 'icon-money',
    })
  }

  return cards
}

/** Quanto da carteira ativa tem pacote vigente agora — estado da base, não do período. */
function packagesCard(finance: FinanceIndicators): Stat {
  const { tutorsWithActive, activeTutors } = finance.packages

  return {
    label: 'Clientes com pacote',
    value: activeTutors === 0 ? null : formatPercent(tutorsWithActive / activeTutors),
    hint:
      activeTutors === 0
        ? 'Nenhum tutor ativo na carteira.'
        : `${format(tutorsWithActive)} de ${format(activeTutors)} tutores ativos com pacote vigente.`,
    icon: <WalletIcon />,
    iconTone: 'icon-money',
    href: '/configuracoes/pacotes',
  }
}

/** "1 pacote", "3 pacotes" — com o separador de milhar do resto do painel. */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count.toLocaleString('pt-BR')} ${count === 1 ? singular : pluralForm}`
}

/** "12,5 dias", e "1 dia": uma casa decimal. */
function formatDays(days: number): string {
  const rounded = Math.round(days * 10) / 10
  return `${formatDecimal(rounded)} ${rounded === 1 ? 'dia' : 'dias'}`
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
/**
 * A linha de apoio do "Recebido hoje". A venda avulsa (MOD-CAIXA) entra no número e é
 * dita à parte: "3 pagamentos e 2 vendas avulsas".
 */
function recebidoHint(cashflow: {
  paymentsCount: number
  walkInCount: number
  byMethod: { method: string; totalCents: number }[]
}): string {
  const { paymentsCount, walkInCount } = cashflow
  if (paymentsCount === 0 && walkInCount === 0) return 'Nenhum pagamento registrado hoje.'
  const partes = [
    paymentsCount > 0 ? `${paymentsCount} pagamento${paymentsCount === 1 ? '' : 's'}` : null,
    walkInCount > 0
      ? `${walkInCount} venda${walkInCount === 1 ? '' : 's'} avulsa${walkInCount === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean)
  return `${partes.join(' e ')}${paymentsCount > 0 ? topMethod(cashflow.byMethod) : ''}.`
}

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
    PIX_ONLINE: 'PIX online',
    CARD_ONLINE: 'cartão online',
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
