import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { serverApi } from '@/lib/api'

/**
 * Moldura das telas de relacionamento.
 *
 * Mesmo gate de onboarding da agenda e do Taxi Dog: antes do wizard não há tutor nem
 * atendimento, e um painel de entregas sobre uma base vazia mostraria zero em tudo —
 * o que é verdade, mas não é a verdade útil.
 */

export const dynamic = 'force-dynamic'

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="mensagens" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
