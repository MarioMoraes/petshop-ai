import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { serverApi } from '@/lib/api'

/**
 * Moldura das telas da agenda.
 *
 * O gate de onboarding vive aqui, e não em cada página: quem não terminou o wizard
 * não tem serviços semeados nem jornada definida, e as telas mostrariam um vazio que
 * não é o vazio real.
 */

export const dynamic = 'force-dynamic'

export default async function AgendaLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="agenda" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
