import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura da assinatura.
 *
 * Mesmo gate de onboarding das outras telas. **Não** tem gate de estado da conta, e isso é
 * o ponto: esta é a tela que o estabelecimento com teste vencido, em atraso ou suspenso
 * precisa abrir — é para cá que o aviso do topo manda.
 */

export const dynamic = 'force-dynamic'

export default async function AssinaturaLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="configuracoes" me={me}>
      <div className="mx-auto max-w-3xl">{children}</div>
    </AppShell>
  )
}
