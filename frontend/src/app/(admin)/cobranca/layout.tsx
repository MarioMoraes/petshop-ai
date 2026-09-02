import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { serverApi } from '@/lib/api'

/**
 * Moldura da Cobrança.
 *
 * O gate mora aqui, e não em cada relatório: `finance:configure` é o mesmo que as rotas
 * `/v1/ledger/reports/*` exigem, e repeti-lo em três páginas daria três lugares para
 * alguém esquecer de mexer. Quem manda continua sendo o `requirePermission` do serviço
 * — isto é a experiência, não a segurança.
 *
 * É deliberadamente mais estreito que `finance:read`: a relação de contas a receber traz
 * nome e telefone de todo tutor em atraso, o que é material de quem responde pelo caixa
 * e não de quem atende o balcão.
 */

export const dynamic = 'force-dynamic'

export default async function CobrancaLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')
  if (!me.permissions.includes('finance:configure')) redirect('/dashboard')

  return (
    <AppShell active="cobranca" me={me}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </AppShell>
  )
}
