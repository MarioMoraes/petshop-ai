import { redirect } from 'next/navigation'
import { serverApi } from '@/lib/api'

/**
 * Porta de entrada: decide entre wizard e dashboard.
 *
 * A decisão vem de `GET /v1/me`, e não de um cookie ou de estado no cliente — quem
 * sabe o estado da conta é o servidor.
 */

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const me = await serverApi().me()

  if (me.currentTenant?.onboardingCompletedAt) {
    redirect('/dashboard')
  }
  redirect('/onboarding')
}
