import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura da assinatura.
 *
 * **Não** tem gate de estado da conta, e isso é o ponto: esta é a tela que o
 * estabelecimento com teste vencido, em atraso ou suspenso precisa abrir — é para cá que o
 * aviso do topo manda.
 *
 * O gate de onboarding vale só para quem **pode** terminar o wizard. Quem teve o teste
 * vencido no meio dele não pode: a escrita está bloqueada, e devolver ao wizard prenderia a
 * pessoa entre uma tela que não grava e outra que ela não alcança. Pagar é a saída, e a
 * saída não pode ficar atrás do wizard.
 */

export const dynamic = 'force-dynamic'

const BLOQUEADOS = ['TRIAL_EXPIRED', 'PAST_DUE', 'SUSPENDED']

export default async function AssinaturaLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  const tenant = me.currentTenant
  const bloqueado = tenant ? BLOQUEADOS.includes(tenant.status) : false
  if (!tenant?.onboardingCompletedAt && !bloqueado) redirect('/onboarding')

  return (
    <AppShell active="configuracoes" me={me}>
      <div className="mx-auto max-w-3xl">{children}</div>
    </AppShell>
  )
}
