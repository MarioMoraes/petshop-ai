import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { carregarMe } from '@/lib/api'

/**
 * Moldura do Início.
 *
 * A `AppShell` morava dentro da página, e saiu de lá pelo mesmo motivo das outras
 * seções: o `loading.tsx` irmão só embrulha a **página**, então esqueleto e moldura
 * precisam estar em níveis diferentes. Com a moldura na página, o esqueleto nasceria
 * numa tela branca, sem menu nem faixa — que é exatamente a piscada que ele existe
 * para evitar.
 *
 * `me` é buscado aqui e de novo na página; `carregarMe` deduplica as duas na mesma
 * requisição.
 */

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <AppShell active="inicio" me={me} atmosphere>
      <div className="mx-auto max-w-5xl">{children}</div>
    </AppShell>
  )
}
