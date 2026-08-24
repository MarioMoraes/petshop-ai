import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { serverApi } from '@/lib/api'

/**
 * Moldura das telas de pets.
 *
 * O gate de onboarding vive aqui, e não em cada página: quem ainda não terminou o
 * wizard não tem catálogo de espécies semeado, e um formulário sem espécie só
 * produziria um erro incompreensível.
 */

export const dynamic = 'force-dynamic'

export default async function PetsLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="pets" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
