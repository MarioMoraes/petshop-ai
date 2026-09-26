import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura do Financeiro: os Relatórios e as Políticas. O Caixa do dia é item próprio do
 * menu (`/caixa`), porque é a tela que o balcão mantém aberta.
 *
 * O gate de leitura vive aqui: quem não tem `finance:read` não vê o item no menu nem
 * alcança a rota digitando a URL. Cada aba faz o próprio segundo gate — `cash:read` e o
 * plano nos relatórios do caixa, `finance:configure` nos de cobrança e no que as
 * Políticas **salvam**.
 *
 * O extrato de um tutor específico **não** mora aqui: ele fica na ficha dele, que é
 * onde o balcão trabalha. E os pacotes pré-pagos também não: são catálogo de serviço,
 * e moram em Configurações.
 *
 * `max-w-6xl`, e não o `5xl` das telas de formulário: é aqui que ficam as tabelas dos
 * relatórios, com uma coluna por forma de pagamento.
 */

export const dynamic = 'force-dynamic'

export default async function FinanceiroLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')
  if (!me.permissions.includes('finance:read')) redirect('/dashboard')

  return (
    <AppShell active="financeiro" me={me}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </AppShell>
  )
}
