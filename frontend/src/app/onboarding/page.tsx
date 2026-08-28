import { redirect } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import { ApiError } from '@petshop/api-client'
import type { TenantResponse, TenantSettings } from '@petshop/shared-types'
import { EnsureActiveOrganization } from '@/components/ensure-active-organization'
import { Logo, Shell } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { ProvisioningNotice } from './provisioning-notice'
import { tenantHostSuffix } from '@/lib/domain'
import { Wizard } from './wizard'

/**
 * MOD-IDENT-02 — a página do wizard.
 *
 * O estado vem do servidor a cada carregamento, e é ele que decide a etapa. É o que
 * faz o AC-03 funcionar sem truque: quem abandonou na etapa 2 e volta três dias
 * depois cai na etapa 2, com os dados preenchidos.
 */

export const dynamic = 'force-dynamic'

export default async function OnboardingPage() {
  const api = serverApi()
  const me = await api.me()

  // Já concluiu: não faz sentido reabrir o wizard.
  if (me.currentTenant?.onboardingCompletedAt) {
    redirect('/dashboard')
  }

  const tenant: TenantResponse | null = me.currentTenant
  let settings: TenantSettings | null = null

  // Sessão sem Organization ativa, mas com vínculo: o `EnsureActiveOrganization`
  // ativa a organização no cliente e recarrega.
  if (!tenant && me.memberships.length > 0) {
    return (
      <OnboardingLayout>
        <EnsureActiveOrganization />
        <p className="hint">Preparando seu estabelecimento…</p>
      </OnboardingLayout>
    )
  }

  if (tenant) {
    // AC-03 de MOD-IDENT-01: enquanto o provisionamento não fecha, o usuário vê
    // "estamos finalizando sua conta" em vez de um erro cru.
    if (tenant.status === 'PROVISIONING' || tenant.status === 'PROVISIONING_FAILED') {
      return (
        <OnboardingLayout>
          <ProvisioningNotice status={tenant.status} />
        </OnboardingLayout>
      )
    }

    try {
      settings = await api.getSettings()
    } catch (error) {
      // Sem permissão de leitura das configurações o wizard segue com os padrões —
      // é melhor do que barrar o onboarding inteiro.
      if (!(error instanceof ApiError)) throw error
      settings = null
    }
  }

  return (
    <OnboardingLayout>
      {tenant === null && <EnsureActiveOrganization />}
      <Wizard tenant={tenant} settings={settings} hostSuffix={tenantHostSuffix()} />
    </OnboardingLayout>
  )
}

function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Logo />
        <UserButton />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:px-10">
        {children}
      </main>
    </Shell>
  )
}
