import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura da Equipe.
 *
 * Só a moldura e o gate de onboarding. O redirect de quem não tem `team:read` continua
 * na página: ele depende do que a tela mostra, e não de haver tela — e é a página que
 * sabe qual permissão pediu.
 */

export const dynamic = 'force-dynamic'

export default async function EquipeLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="equipe" me={me}>
      <div className="mx-auto max-w-3xl">{children}</div>
    </AppShell>
  )
}
