import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { serverApi } from '@/lib/api'

/**
 * Moldura das telas de tutores.
 *
 * O gate de onboarding vive aqui, e não em cada página: quem ainda não terminou o
 * wizard não tem tenant configurado, e uma tela de cadastro sem tenant só produziria
 * um erro incompreensível.
 */

export const dynamic = 'force-dynamic'

export default async function TutoresLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="tutores" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
