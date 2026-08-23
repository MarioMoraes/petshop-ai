import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ROLE_LABELS, type RoleKey } from '@petshop/shared-types'
import { AppHeader, trialDaysLeftOf } from '@/components/app-header'
import { Card, Shell } from '@/components/ui'
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
 */

export const dynamic = 'force-dynamic'

interface Stat {
  label: string
  value: number | null
  hint: string
  href?: '/tutores' | '/pets'
}

export default async function DashboardPage() {
  const me = await serverApi().me()

  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  const tenant = me.currentTenant
  const membership = me.memberships.find((item) => item.tenantId === tenant.id)
  const role = (membership?.roleKey ?? 'RECEPTIONIST') as RoleKey

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
      hint: tutors === 1 ? 'cadastro ativo' : 'cadastros ativos',
      href: '/tutores',
    },
    {
      label: 'Pets',
      value: pets,
      hint: pets === 1 ? 'animal cadastrado' : 'animais cadastrados',
      href: '/pets',
    },
  ]

  return (
    <Shell>
      <AppHeader
        active="inicio"
        canReadSettings={me.permissions.includes('tenant:read_settings')}
        trialDaysLeft={trialDaysLeftOf(tenant.trialEndsAt)}
      />

      <main className="flex-1 px-6 pb-16 pt-8 sm:px-10">
        <div className="mx-auto max-w-5xl">
          <p className="hint">{ROLE_LABELS[role]}</p>
          <h1 className="mt-2 text-4xl font-semibold leading-tight sm:text-5xl">
            {greetingFor(settings?.timezone)},{' '}
            <span className="font-serif italic">{firstNameOf(me.user.fullName)}</span>.
          </h1>
          <p className="hint mt-3">
            {tenant.name} · <span className="font-medium text-ink">{tenant.slug}.petshopai.app</span>
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-2">
            {stats.map((stat) => (
              <Card key={stat.label}>
                <p className="text-4xl font-semibold tabular-nums">
                  {stat.value ?? <span className="text-subtle">—</span>}
                </p>
                <p className="mt-2 font-medium">{stat.label}</p>
                <p className="hint mt-0.5">
                  {stat.value === null ? 'indisponível agora' : stat.hint}
                </p>
                {stat.href && (
                  <Link href={stat.href} className="btn btn-ghost mt-4 px-0 text-sm text-accent-ink">
                    Abrir →
                  </Link>
                )}
              </Card>
            ))}
          </div>

          {/* Diagnóstico útil enquanto os demais módulos não chegam. */}
          <details className="mt-12">
            <summary className="hint cursor-pointer">Suas permissões neste estabelecimento</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              {me.permissions.map((permission) => (
                <span key={permission} className="pill bg-black/5 px-3 py-1 font-mono text-xs">
                  {permission}
                </span>
              ))}
            </div>
          </details>
        </div>
      </main>
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
