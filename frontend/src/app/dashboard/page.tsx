import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { AppHeader, trialDaysLeftOf } from '@/components/app-header'
import { Atmosphere, CardBloom } from '@/components/atmosphere'
import { PawPrintIcon, UsersIcon } from '@/components/icons'
import { Shell } from '@/components/ui'
import { serverApi } from '@/lib/api'

/**
 * Início — a tela em que o admin cai depois de configurar o estabelecimento.
 *
 * Já foi um checklist de onboarding ("cadastre seu primeiro tutor", "convide sua
 * equipe"). Não é mais: terminar a configuração e continuar sendo cobrado por tarefas
 * faz o produto parecer que nunca começou. O que fica é o estado do negócio — os
 * números e o caminho até eles. A navegação para cadastrar mora no menu, e repeti-la
 * aqui como atalho só dava duas portas para a mesma sala.
 *
 * Os números vêm da API a cada carga. Nenhum é calculado aqui — `total` da listagem é
 * o que o serviço já sabe responder, e um contador próprio divergiria na primeira
 * exclusão.
 *
 * É a única tela com a atmosfera do design ligada. Ela custa nada e dá identidade ao
 * ponto de entrada; repetida nas telas de trabalho — listagem, formulário — passaria a
 * disputar atenção com o dado.
 */

export const dynamic = 'force-dynamic'

interface Stat {
  label: string
  value: number | null
  hint: string
  icon: ReactNode
  href: '/tutores' | '/pets'
}

export default async function DashboardPage() {
  const me = await serverApi().me()

  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  const tenant = me.currentTenant

  // `limit: 1` porque só o `total` interessa: a listagem inteira seria desperdício.
  // Cada contagem cai para `null` sozinha — um serviço fora do ar apaga o número
  // dele, não a tela toda.
  const [tutors, pets, settings] = await Promise.all([
    serverApi()
      .listTutors({ limit: 1 })
      .then((page) => page.total)
      .catch(() => null),
    serverApi()
      .listPets({ limit: 1 })
      .then((page) => page.total)
      .catch(() => null),
    serverApi()
      .getSettings()
      .catch(() => null),
  ])

  const stats: Stat[] = [
    {
      label: 'Tutores',
      value: tutors,
      hint:
        tutors === null
          ? 'Contagem indisponível agora.'
          : 'Quem responde pelos animais e recebe os lançamentos.',
      icon: <UsersIcon />,
      href: '/tutores',
    },
    {
      label: 'Pets',
      value: pets,
      hint:
        pets === null
          ? 'Contagem indisponível agora.'
          : 'Os animais atendidos, com espécie, porte e responsáveis.',
      icon: <PawPrintIcon />,
      href: '/pets',
    },
  ]

  return (
    <Shell>
      <Atmosphere />

      {/* `relative z-10`: sem isso os blooms posicionados pintariam por cima do texto. */}
      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader
          active="inicio"
          canReadSettings={me.permissions.includes('tenant:read_settings')}
          trialDaysLeft={trialDaysLeftOf(tenant.trialEndsAt)}
        />

        <main className="flex-1 px-6 pb-16 pt-8 sm:px-10">
          <div className="mx-auto max-w-5xl">
            <h1 className="font-serif text-4xl italic leading-tight sm:text-5xl">
              {tenant.name}
            </h1>
            {/* Título 4 · Card padrão do design: 1.125rem / 1.75rem, peso 600. */}
            <p className="mt-2 text-lg font-semibold">
              {greetingFor(settings?.timezone)}, {firstNameOf(me.user.fullName)}.
            </p>

            <div className="mt-10 grid gap-5 sm:grid-cols-2">
              {stats.map((stat) => (
                <Link
                  key={stat.label}
                  href={stat.href}
                  className="card card-interactive relative overflow-hidden p-7"
                >
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
                </Link>
              ))}
            </div>
          </div>
        </main>
      </div>
    </Shell>
  )
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
