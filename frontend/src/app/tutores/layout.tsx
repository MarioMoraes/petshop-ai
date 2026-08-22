import Link from 'next/link'
import { redirect } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import { Logo, Shell } from '@/components/ui'
import { serverApi } from '@/lib/api'

/**
 * Moldura das telas de tutores.
 *
 * O gate de onboarding vive aqui, e não em cada página: quem ainda não terminou o
 * wizard não tem tenant configurado, e uma tela de cadastro sem tenant só produziria
 * um erro incompreensível.
 */

export const dynamic = 'force-dynamic'

export default async function TutoresLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  return (
    <Shell>
      <header className="flex items-center justify-between border-b border-line px-6 py-5 sm:px-10">
        <div className="flex items-center gap-8">
          <Link href="/dashboard" aria-label="Ir para o início">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/dashboard" className="btn btn-ghost px-3 py-1.5">
              Início
            </Link>
            <Link href="/tutores" className="btn btn-ghost bg-black/5 px-3 py-1.5 text-ink">
              Tutores
            </Link>
          </nav>
        </div>
        <UserButton />
      </header>

      <main className="flex-1 px-6 pb-16 pt-8 sm:px-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </Shell>
  )
}
