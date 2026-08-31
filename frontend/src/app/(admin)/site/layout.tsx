import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { serverApi } from '@/lib/api'

/**
 * Moldura das telas do site.
 *
 * Mesmo gate de onboarding das outras: antes do wizard não há nome, cor, endereço nem
 * serviço, e a página do petshop é montada exatamente disso — o site nasceria vazio e
 * o admin concluiria que o recurso não funciona.
 */

export const dynamic = 'force-dynamic'

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="site" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
