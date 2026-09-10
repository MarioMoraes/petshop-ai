import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura das telas do Taxi Dog.
 *
 * Mesmo gate de onboarding da agenda: sem o wizard terminado não há profissionais
 * nem serviços, e o painel mostraria um vazio que não é o vazio real.
 */

export const dynamic = 'force-dynamic'

export default async function TaxiLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="taxi" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
