import { redirect } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import { ROLE_LABELS, type RoleKey } from '@petshop/shared-types'
import { Badge, Card, Logo, Shell } from '@/components/ui'
import { serverApi } from '@/lib/api'

/**
 * Dashboard pós-onboarding.
 *
 * A tela que o AC-01 de MOD-IDENT-02 descreve como destino do wizard, com o
 * checklist "Cadastre seu primeiro tutor". O que ainda não existe aparece como tal,
 * em vez de virar um botão que não leva a lugar nenhum.
 */

export const dynamic = 'force-dynamic'

interface ChecklistItem {
  title: string
  description: string
  module: string
  done: boolean
}

export default async function DashboardPage() {
  const me = await serverApi().me()

  if (!me.currentTenant) redirect('/onboarding')
  if (!me.currentTenant.onboardingCompletedAt) redirect('/onboarding')

  const tenant = me.currentTenant
  const membership = me.memberships.find((item) => item.tenantId === tenant.id)
  const role = (membership?.roleKey ?? 'RECEPTIONIST') as RoleKey

  const checklist: ChecklistItem[] = [
    {
      title: 'Configure seu estabelecimento',
      description: 'Horário, políticas de cancelamento e identidade visual.',
      module: 'Concluído no onboarding',
      done: true,
    },
    {
      title: 'Cadastre seu primeiro tutor',
      description: 'O cadastro do tutor é o ponto de partida de tudo: pets, agenda e conta corrente.',
      module: 'MOD-TUTOR',
      done: false,
    },
    {
      title: 'Convide sua equipe',
      description: 'Recepção, banhistas, tosadores e veterinários, cada um com seu acesso.',
      module: 'MOD-IDENT-06',
      done: false,
    },
  ]

  const trialDaysLeft = tenant.trialEndsAt
    ? Math.max(
        0,
        Math.ceil((new Date(tenant.trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
      )
    : null

  return (
    <Shell>
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Logo />
        <div className="flex items-center gap-4">
          {tenant.status === 'TRIAL' && trialDaysLeft !== null && (
            <Badge tone="accent">
              {trialDaysLeft === 0
                ? 'Último dia de teste'
                : `${trialDaysLeft} ${trialDaysLeft === 1 ? 'dia' : 'dias'} de teste`}
            </Badge>
          )}
          <UserButton />
        </div>
      </header>

      <main className="flex-1 px-6 pb-16 sm:px-10">
        <div className="mx-auto max-w-3xl">
          <p className="hint">{ROLE_LABELS[role]}</p>
          <h1 className="mt-2 text-4xl font-semibold leading-tight sm:text-5xl">
            Tudo pronto, <span className="font-serif italic">{tenant.name}</span>.
          </h1>
          <p className="hint mt-3">
            Seu portal está em{' '}
            <span className="font-medium text-ink">{tenant.slug}.petshopai.app</span>
          </p>

          <h2 className="mt-12 text-lg font-semibold">Próximos passos</h2>
          <div className="mt-4 space-y-3">
            {checklist.map((item) => (
              <Card key={item.title} className="flex items-start gap-4">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                    item.done ? 'bg-success-soft text-success' : 'bg-black/5 text-subtle'
                  }`}
                  aria-hidden="true"
                >
                  {item.done ? '✓' : '·'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className={`font-semibold ${item.done ? 'text-subtle line-through' : ''}`}>
                      {item.title}
                    </h3>
                    {!item.done && <Badge>Em breve · {item.module}</Badge>}
                  </div>
                  <p className="hint mt-1">{item.description}</p>
                </div>
              </Card>
            ))}
          </div>

          {/* Diagnóstico útil enquanto os demais módulos não chegam. */}
          <details className="mt-10">
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
