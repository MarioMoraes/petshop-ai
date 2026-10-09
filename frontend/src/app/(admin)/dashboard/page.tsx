import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  DEFAULT_TIMEZONE,
  formatBRL,
  todayIn,
  type FinanceIndicators,
  type NoShowReport,
  type OverdueVaccinesReport,
} from '@petshop/shared-types'
import {
  CalendarCheckDuoIcon,
  CalendarXDuoIcon,
  HandCoinsDuoIcon,
  BillClockDuoIcon,
  PawDuoIcon,
  SyringeDuoIcon,
  StopwatchDuoIcon,
  AlarmClockDuoIcon,
  UsersDuoIcon,
  type IconTone,
} from '@/components/icons'
import { carregarMe, serverApi } from '@/lib/api'
import { STAT_GRID, STAT_SHAPE } from './stat-grid'

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
 * O Movimento abre com os atendimentos dos últimos sete dias, e não com o número de hoje:
 * o dia isolado não diz se está bom ou ruim. Até 2026-10-07 era um gráfico de barras dos
 * sete dias; saiu a pedido, e ficou o total — o dia a dia está na agenda, a um clique.
 *
 * Nenhum número é calculado a partir de listagem — `total` é o que o serviço já sabe
 * responder, e um contador próprio divergiria na primeira exclusão. Cada bloco cai para
 * `null` sozinho: um serviço fora do ar apaga o número dele, não a tela toda. E cada
 * cartão respeita a permissão do módulo — um banhista não vê contas a receber.
 *
 * O roadmap do que os PRDs pedem e ainda não tem dado ("Em breve") saiu em 2026-09-15, a
 * pedido: o painel mostra o que responde. Dos três indicadores que esperavam o dado ser
 * gravado, as vacinas atrasadas voltaram como cartão em 2026-10-09, quando a carteira
 * passou a existir; os bloqueios por alergia e os do self-service do Portal voltam
 * quando existirem, e não como promessa. As faixas do Taxi Dog
 * e do Portal do tutor saíram em 2026-10-03, também a pedido; os relatórios do backend
 * que as alimentavam continuam de pé. Pela mesma razão saíram de "Sua base", em
 * 2026-10-07, os pets com alerta crítico, os cadastros completos, quem aceita WhatsApp e
 * os clientes com pacote — a faixa ficou com tutores e pets.
 *
 * **Todo cartão tem o mesmo tamanho** (`STAT_SHAPE` e `STAT_GRID`): 280 por 224px — a
 * proporção do cartão de referência, em escala maior —, em qualquer faixa.
 *
 * **O cartão não tem dica.** Até 2026-10-07 cada número vinha com uma frase embaixo — os
 * inativos, a média de pets por tutor, a forma de pagamento que mais entrou, a multa de
 * falta ligada ou não. Saíram a pedido, e com elas as leituras que só as alimentavam:
 * as configurações e as contagens de inativos. O cartão é rótulo e número, e o clique
 * leva ao detalhe.
 *
 * **O cartão de número é branco, e não o cinza do resto do sistema.** Veio do cartão de
 * referência que o usuário trouxe em 2026-10-07 — ícone, rótulo e valor num cartão
 * pequeno e liso. O cinza (`docs/design-formularios.md`) existe para recortar o campo
 * branco do formulário, e aqui não há campo. O brilho da atmosfera saiu junto: sobre
 * branco ele vira mancha.
 */

export const dynamic = 'force-dynamic'

/**
 * A janela da faixa do Financeiro.
 *
 * Trinta dias, e não sete como os atendimentos: os indicadores são médias e proporções,
 * e uma semana de um petshop médio não tem movimento que as sustente — a contagem
 * sobrevive a um dia fraco, o percentual não.
 */
const REPORT_DAYS = 30

interface Stat {
  label: string
  /** `null` quando o serviço que responde por este número não respondeu. */
  value: string | null
  icon: ReactNode
  /**
   * Família de cor do chip: diz de que assunto o cartão trata. É informação diferente
   * de `tone`, logo abaixo — o chip diz o tipo, o número diz o estado. Um cartão de
   * dinheiro é verde mesmo quando o valor está vencido e sai em vermelho.
   */
  iconTone: IconTone
  href?:
    '/tutores' | '/pets' | '/agenda/dia' | '/financeiro/configuracoes' | '/configuracoes/pacotes'
  /**
   * Um documento que o cartão abre numa aba nova, no lugar de uma tela. É `<a>` e não
   * `<Link>`: o prefetch do Link chamaria o Gotenberg a cada vez que o Início abre.
   */
  document?: '/dashboard/vacinas-atrasadas'
  /** Destaca o número quando ele pede ação — dívida vencida, dia lotado. */
  tone?: 'danger'
}

export default async function DashboardPage() {
  // O gate de onboarding e a moldura ficam no layout, como nas demais seções.
  const me = await carregarMe()

  const can = (permission: string): boolean => me.permissions.includes(permission)

  const timezone = me.timezone ?? DEFAULT_TIMEZONE
  // "Hoje" é o dia do estabelecimento, não o do servidor: um petshop em Rio Branco
  // veria a agenda do dia seguinte a partir das 21h se isto viesse de UTC.
  const hoje = todayIn(timezone)

  /*
   * `limit: 1` porque só o `total` interessa, e com `status: 'ACTIVE'` porque a listagem
   * sem filtro soma ativos e inativos.
   *
   * A agenda e o financeiro só são consultados por quem pode vê-los — pedir e receber
   * 403 funcionaria, mas gastaria a viagem e sujaria o log de segurança todo dia.
   */
  const [activeTutors, activePets, movement, receivables, cashflow, finance, noShows, vaccines] =
    await Promise.all([
      countOf(() => serverApi().listTutors({ status: 'ACTIVE', limit: 1 })),
      countOf(() => serverApi().listPets({ status: 'ACTIVE', limit: 1 })),
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
      // A contagem da casa inteira é leitura de gestão, como a rota diz: a recepção e o
      // veterinário a têm, o banhista e o motorista não.
      can('record:read_summary')
        ? serverApi()
            .getOverdueVaccines()
            .catch(() => null)
        : Promise.resolve(null),
    ])

  /*
   * A faixa era três cartões: atendimentos de hoje, ocupação de hoje e caixa. Os dois
   * primeiros saíram — a semana responde melhor à mesma pergunta, e o número do dia
   * sozinho só dizia alguma coisa depois de o dono lembrar como foi a semana. Quem quer o
   * dia inteiro clica no cartão e cai na agenda, que é onde ele está de verdade.
   */
  const fluxo: Stat[] = []
  if (movement) {
    fluxo.push({
      label: 'Atendimentos',
      value: `${format(movement.days.reduce((sum, day) => sum + day.total, 0))} em 7 dias`,
      icon: <CalendarCheckDuoIcon />,
      iconTone: 'icon-time',
      href: '/agenda/dia',
    })
  }
  if (cashflow) {
    fluxo.push({
      label: 'Recebido',
      value: `${formatBRL(cashflow.totalCents)} hoje`,
      icon: <HandCoinsDuoIcon />,
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
      icon: <BillClockDuoIcon />,
      iconTone: 'icon-money',
      href: '/financeiro/configuracoes',
      ...(overdue > 0 ? { tone: 'danger' as const } : {}),
    })
  }

  if (vaccines) {
    fluxo.push(overdueVaccinesCard(vaccines))
  }

  const base: Stat[] = [
    {
      label: 'Tutores',
      value: suffixed(format(activeTutors), 'ativos'),
      icon: <UsersDuoIcon />,
      iconTone: 'icon-people',
      href: '/tutores',
    },
    {
      label: 'Pets',
      value: suffixed(format(activePets), 'ativos'),
      icon: <PawDuoIcon />,
      iconTone: 'icon-pet',
      href: '/pets',
    },
  ]
  const financeStats = financeCards(finance, noShows)

  return (
    <>
      {fluxo.length > 0 && <StatSection title="Movimento" stats={fluxo} />}
      {financeStats.length > 0 && <StatSection title="Financeiro" stats={financeStats} />}

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
 * O Financeiro olha para os últimos 30 dias (`REPORT_DAYS`), e até 2026-10-07 dizia isso
 * ao lado do título; a nota saiu a pedido.
 */
function StatSection({ title, stats }: { title: string; stats: Stat[] }) {
  return (
    // `first:mt-0`: com a saudação na topbar, a primeira faixa encosta no `pt` do
    // conteúdo — somar a margem daria ao Início um vão de abertura sem nada dentro.
    <section className="mt-8 first:mt-0">
      <h2 className="text-sm font-medium uppercase tracking-[0.06em] text-subtle">{title}</h2>

      <div className={`mt-4 ${STAT_GRID}`}>
        {stats.map((stat) => {
          const body = (
            <>
              <div className="flex flex-1 flex-col">
                {/*
                  O molde do cartão de número (2026-10-07): o ícone grande no alto, e no
                  pé o rótulo e, logo embaixo, o valor na cor do assunto — o tom do chip
                  pinta o valor também, então dinheiro é verde e agenda é a cor da agenda.
                  O vermelho da dívida vencida passa por cima do tom, porque é estado e
                  não assunto. Sem valor, "Sem registros" em cinza, no lugar do traço.

                  O rótulo é uma palavra ou duas, e cabe numa linha; o resto do
                  que o número quer dizer vai **no valor** ("R$ 450,00 hoje", "12 em 7
                  dias"), como no cartão de referência ("Amamentação" / "há 7h"). Rótulo
                  de três palavras quebrava em duas linhas e espremia o cartão.
                */}
                <span className={`icon-chip icon-chip-lg ${stat.iconTone}`}>{stat.icon}</span>
                <div className="mt-auto pt-3">
                  <p className="text-base font-semibold leading-snug sm:text-xl">{stat.label}</p>
                  <p
                    className={`mt-0.5 text-sm font-semibold tabular-nums sm:text-lg ${
                      stat.value === null
                        ? 'text-subtle'
                        : stat.tone === 'danger'
                          ? 'text-danger'
                          : `${stat.iconTone} text-[var(--icon)]`
                    }`}
                  >
                    {stat.value ?? 'Sem registros'}
                  </p>
                </div>
              </div>
            </>
          )

          // Só vira link o cartão que tem para onde levar: um cartão clicável que não
          // navega é pior que um cartão parado.
          if (stat.document) {
            return (
              <a
                key={stat.label}
                href={stat.document}
                target="_blank"
                rel="noopener"
                className={`card card-interactive flex flex-col bg-card p-4 sm:p-6 ${STAT_SHAPE}`}
              >
                {body}
              </a>
            )
          }
          return stat.href ? (
            <Link
              key={stat.label}
              href={stat.href}
              className={`card card-interactive flex flex-col bg-card p-4 sm:p-6 ${STAT_SHAPE}`}
            >
              {body}
            </Link>
          ) : (
            <div key={stat.label} className={`card flex flex-col bg-card p-4 sm:p-6 ${STAT_SHAPE}`}>
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
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
 * PRD: a multa é calculada na falta e não vira lançamento, então não há cobrança a somar.
 */
function financeCards(finance: FinanceIndicators | null, noShows: NoShowReport | null): Stat[] {
  const cards: Stat[] = []

  if (finance) {
    const { averageDays } = finance.collection
    const { valueCents } = finance.expired

    cards.push({
      label: 'Prazo médio',
      value: averageDays === null ? null : `${formatDays(averageDays)} para receber`,
      icon: <StopwatchDuoIcon />,
      iconTone: 'icon-metric',
    })

    cards.push({
      label: 'Crédito vencido',
      value: `${formatBRL(valueCents)} sem uso`,
      icon: <AlarmClockDuoIcon />,
      iconTone: 'icon-money',
      href: '/configuracoes/pacotes',
    })
  }

  if (noShows) {
    cards.push({
      label: 'Faltas',
      value: `${formatBRL(noShows.totalCents)} perdidos`,
      icon: <CalendarXDuoIcon />,
      iconTone: 'icon-time',
    })
  }

  return cards
}

/**
 * Pets com vacina atrasada — o indicador que esperava o dado existir, e que voltou como
 * cartão quando a carteira de vacinação (MOD-PRONT-08) passou a gravar a próxima dose.
 *
 * Está no Movimento, e não em "Sua base", pelo mesmo motivo do "Em aberto": é número para
 * agir hoje — ligar para o tutor —, e não cadastro. Conta **pets**, e não doses: quem liga
 * liga uma vez, ainda que o pet deva duas vacinas. A regra do que é atrasada é a da
 * carteira, decidida no servidor.
 *
 * O clique abre a lista em PDF numa aba nova — pet, tutor, telefone e as vacinas que ele
 * deve —, a pedido do usuário em 2026-10-09: é a folha de quem vai ligar. Com zero pets
 * não há o que abrir, e o cartão fica parado.
 */
function overdueVaccinesCard(report: OverdueVaccinesReport): Stat {
  return {
    label: 'Vacinas atrasadas',
    value: `${report.pets.toLocaleString('pt-BR')} ${report.pets === 1 ? 'pet' : 'pets'}`,
    icon: <SyringeDuoIcon />,
    iconTone: 'icon-pet',
    ...(report.pets > 0
      ? { tone: 'danger' as const, document: '/dashboard/vacinas-atrasadas' as const }
      : {}),
  }
}

/** "12,5 dias", e "1 dia": uma casa decimal. */
function formatDays(days: number): string {
  const rounded = Math.round(days * 10) / 10
  return `${formatDecimal(rounded)} ${rounded === 1 ? 'dia' : 'dias'}`
}

/** Uma casa, com vírgula: 22,4 — e "22" quando o decimal é zero. */
function formatDecimal(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

/** Total de uma listagem paginada, ou `null` se o serviço não respondeu. */
async function countOf(fetchPage: () => Promise<{ total: number }>): Promise<number | null> {
  return fetchPage()
    .then((page) => page.total)
    .catch(() => null)
}

/** "120 ativos" — ou `null`, que o cartão mostra como "Sem registros". */
function suffixed(value: string | null, suffix: string): string | null {
  return value === null ? null : `${value} ${suffix}`
}

/** Separador de milhar brasileiro: 1.240, não 1240. */
function format(value: number | null): string | null {
  return value === null ? null : value.toLocaleString('pt-BR')
}
