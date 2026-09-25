import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura das telas de estoque (MOD-ESTOQUE).
 *
 * O gate de plano **não** mora aqui: o layout e a página renderizam em paralelo, e é a
 * página que pergunta `temRecurso` antes de chamar a API (ver `plano-indisponivel.tsx`).
 */

export const dynamic = 'force-dynamic'

export default async function EstoqueLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="estoque" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
