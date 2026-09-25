import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura do caixa do dia (MOD-CAIXA).
 *
 * O gate de plano mora na página, e não aqui, pela mesma razão do estoque: layout e
 * página renderizam em paralelo (ver `plano-indisponivel.tsx`).
 */

export const dynamic = 'force-dynamic'

export default async function CaixaLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="caixa" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
