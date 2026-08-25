import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { serverApi } from '@/lib/api'

/**
 * Moldura das telas do financeiro (MOD-LEDGER).
 *
 * O gate de leitura vive aqui, e não em cada página: quem não tem `finance:read` não
 * vê o item no menu nem alcança a rota digitando a URL. As telas internas fazem o
 * segundo gate — `finance:configure` — sobre o que pode **salvar**.
 *
 * O extrato de um tutor específico **não** mora aqui: ele fica na ficha dele, que é
 * onde o balcão trabalha. Estas telas são a política do estabelecimento.
 */

export const dynamic = 'force-dynamic'

export default async function FinanceiroLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')
  if (!me.permissions.includes('finance:read')) redirect('/dashboard')

  return (
    <AppShell active="financeiro" me={me}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
