import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura das Configurações.
 *
 * Mais larga que as outras telas de formulário, e por uma razão medida: a faixa de abas
 * passou de nove com o Suporte do MOD-ADMIN-02, e em `max-w-3xl` ela quebrava em duas
 * linhas — a segunda ficava com duas abas soltas, que leem como sobra e não como
 * continuação. `max-w-4xl` cabe as nove numa linha só sem chegar à largura das telas de
 * lista (`max-w-5xl`), que deixaria os campos longos demais para preencher.
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
      <div className="mx-auto max-w-4xl">{children}</div>
    </AppShell>
  )
}
