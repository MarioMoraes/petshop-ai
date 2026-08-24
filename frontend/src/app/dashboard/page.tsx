import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { CardBloom } from '@/components/atmosphere'
import { PawPrintIcon, TrendingUpIcon, UsersIcon } from '@/components/icons'
import { serverApi } from '@/lib/api'
import { Roadmap } from './roadmap'

/**
 * Início — o painel do estabelecimento.
 *
 * Já foi um checklist de onboarding ("cadastre seu primeiro tutor", "convide sua
 * equipe"). Não é mais: terminar a configuração e continuar sendo cobrado por tarefas
 * faz o produto parecer que nunca começou. O que fica é o estado do negócio — os
 * números e o caminho até eles. A navegação para cadastrar mora no menu, e repeti-la
 * aqui como atalho só dava duas portas para a mesma sala.
 *
 * A tela tem duas metades de natureza diferente, e a diferença é visível de propósito:
 * em cima, os números que a API responde hoje; embaixo, os indicadores que os PRDs já
 * especificaram e que dependem de módulos ainda não construídos (ver `roadmap.tsx`).
 *
 * Nenhum número é calculado aqui a partir de listagem — `total` é o que o serviço já
 * sabe responder, e um contador próprio divergiria na primeira exclusão. A única conta
 * feita nesta tela é a média de pets por tutor, que é divisão de dois totais.
 *
 * É a única tela com a atmosfera do design ligada. Ela custa nada e dá identidade ao
 * ponto de entrada; repetida nas telas de trabalho — listagem, formulário — passaria a
 * disputar atenção com o dado.
 */

export const dynamic = 'force-dynamic'

interface Stat {
  label: string
  /** `null` quando o serviço que responde por este número não respondeu. */
  value: string | null
  hint: string
  icon: ReactNode
  href?: '/tutores' | '/pets'
}

export default async function DashboardPage() {
  const me = await serverApi().me()

  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  const tenant = me.currentTenant

  /*
   * `limit: 1` porque só o `total` interessa: a listagem inteira seria desperdício.
   * Cada contagem cai para `null` sozinha — um serviço fora do ar apaga o número dele,
   * não a tela toda.
   *
   * Ativos e inativos vêm em chamadas separadas porque a listagem sem filtro devolve
   * os dois somados (e some com os terminais: MERGED, ANONYMIZED, falecido,
   * transferido). Somar aqui é mais barato que pedir ao serviço um agregado que ele
   * ainda não expõe.
   */
  const [activeTutors, inactiveTutors, activePets, inactivePets, settings] = await Promise.all([
    countOf(() => serverApi().listTutors({ status: 'ACTIVE', limit: 1 })),
    countOf(() => serverApi().listTutors({ status: 'INACTIVE', limit: 1 })),
    countOf(() => serverApi().listPets({ status: 'ACTIVE', limit: 1 })),
    countOf(() => serverApi().listPets({ status: 'INACTIVE', limit: 1 })),
    serverApi()
      .getSettings()
      .catch(() => null),
  ])

  const stats: Stat[] = [
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
      href: '/tutores',
    },
    {
      label: 'Pets ativos',
      value: format(activePets),
      hint:
        activePets === null
          ? 'Contagem indisponível agora.'
          : inactivePets
            ? `Mais ${format(inactivePets)} sem visita recente.`
            : 'Os animais atendidos, com espécie, porte e responsáveis.',
      icon: <PawPrintIcon />,
      href: '/pets',
    },
    {
      // `pet_per_tutor_avg` do PRD de pets: indicador de ticket potencial.
      label: 'Pets por tutor',
      value: petsPerTutor(activePets, inactivePets, activeTutors, inactiveTutors),
      hint: 'Média da base inteira. Quanto maior, mais o mesmo cliente rende por visita.',
      icon: <TrendingUpIcon />,
    },
  ]

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
          {greetingFor(settings?.timezone)}, {firstNameOf(me.user.fullName)}.
        </p>

        <section className="mt-10">
          <h2 className="sr-only">Sua base hoje</h2>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {stats.map((stat) => {
              const body = (
                <>
                  <CardBloom />

                  {/* O conteúdo sobe acima do bloom pelo mesmo motivo do shell. */}
                  <div className="relative z-10">
                    <span className="icon-chip">{stat.icon}</span>
                    <p className="mt-5 text-4xl font-semibold tabular-nums">
                      {stat.value ?? <span className="text-subtle">—</span>}
                    </p>
                    <p className="mt-1 text-lg font-semibold">{stat.label}</p>
                    <p className="mt-3 text-sm leading-relaxed text-muted">{stat.hint}</p>
                  </div>
                </>
              )

              // Só vira link o cartão que tem para onde levar: um cartão clicável que
              // não navega é pior que um cartão parado.
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

        <Roadmap permissions={me.permissions} />
      </div>
    </AppShell>
  )
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
 * Média de pets por tutor, uma casa decimal.
 *
 * Só existe se as quatro contagens vieram — com uma faltando, a média seria uma razão
 * entre bases diferentes, e um número errado é pior que um traço.
 */
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
function greetingFor(timezone: string | undefined): string {
  const hour = Number(
    new Intl.DateTimeFormat('pt-BR', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone ?? 'America/Sao_Paulo',
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
