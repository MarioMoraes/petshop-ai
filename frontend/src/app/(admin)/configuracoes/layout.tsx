import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura das Configurações.
 *
 * `max-w-6xl`, a mesma largura de toda tela do menu (decisão de 2026-10-05: trocar de
 * item não pode mudar a largura da área de trabalho). A de referência é a dos Relatórios.
 *
 * O redirect de quem não tem `tenant:read_settings` continua na página, junto do resto
 * dos gates que decidem o **conteúdo** de cada aba.
 */

export const dynamic = 'force-dynamic'

export default async function ConfiguracoesLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="configuracoes" me={me}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </AppShell>
  )
}
