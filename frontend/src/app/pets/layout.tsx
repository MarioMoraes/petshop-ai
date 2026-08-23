import { redirect } from 'next/navigation'
import { AppHeader, trialDaysLeftOf } from '@/components/app-header'
import { Shell } from '@/components/ui'
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
    <Shell>
      <AppHeader
        active="pets"
        canReadSettings={me.permissions.includes('tenant:read_settings')}
        trialDaysLeft={trialDaysLeftOf(me.currentTenant.trialEndsAt)}
      />

      <main className="flex-1 px-6 pb-16 pt-8 sm:px-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </Shell>
  )
}
