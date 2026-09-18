import { redirect } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import { ApiError } from '@petshop/api-client'
import { parsePlanParam, type TenantResponse, type TenantSettings } from '@petshop/shared-types'
import { EnsureActiveOrganization } from '@/components/ensure-active-organization'
import { ButtonLink } from '@/components/links'
import { Card, Logo, Shell } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { fetchPlanPrices } from '@/lib/plan-prices'
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

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // O plano escolhido na landing. Só vale para o estabelecimento que ainda vai nascer:
  // depois dele, o plano gravado é o que a etapa 2 mostra.
  const initialPlan = parsePlanParam((await searchParams).plan)
  const api = serverApi()
  const me = await api.me()
  // O preço vigente da tabela, para a etapa 2 mostrar o que o checkout vai cobrar — e
  // não o número que estava no código no dia do deploy.
  const prices = await fetchPlanPrices()

  // Já concluiu: não faz sentido reabrir o wizard.
  if (me.currentTenant?.onboardingCompletedAt) {
    redirect('/dashboard')
  }

  const tenant: TenantResponse | null = me.currentTenant
  let settings: TenantSettings | null = null

  /*
   * Os estabelecimentos que são nossos de verdade.
   *
   * A sessão pode estar numa Organization do Clerk que não corresponde a tenant
   * nenhum — o `force_organization_selection` da instância faz o próprio Clerk criar
   * uma no cadastro (`docs/setup-clerk.md` §2). Passar esta lista é o que impede o
   * `EnsureActiveOrganization` de tentar ativar essa órfã e ficar recarregando.
   */
  const knownSlugs = me.memberships
    .filter((membership) => membership.status === 'ACTIVE')
    .map((membership) => membership.tenantSlug)

  // Sessão sem Organization ativa, mas com vínculo: o `EnsureActiveOrganization`
  // ativa a organização no cliente e recarrega. Com mais de um vínculo ele pergunta em
  // qual entrar, em vez de escolher sozinho — e é ele que exibe a espera, porque só
  // ele sabe qual dos dois estados está em curso.
  if (!tenant && me.memberships.length > 0) {
    return (
      <OnboardingLayout>
        <EnsureActiveOrganization waiting knownSlugs={knownSlugs} />
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

    /**
     * O teste venceu no meio do wizard.
     *
     * Nada mais grava (a sessão responde 423), então deixar o wizard aberto seria oferecer
     * campos que não salvam. A saída é assinar, e o cartão leva para lá.
     */
    if (tenant.status === 'TRIAL_EXPIRED' || tenant.status === 'SUSPENDED') {
      return (
        <OnboardingLayout>
          <Card className="max-w-lg text-center">
            <h1 className="text-2xl font-semibold">
              {tenant.status === 'TRIAL_EXPIRED'
                ? 'Seu período de teste terminou'
                : 'Sua assinatura está suspensa'}
            </h1>
            <p className="hint mt-3">
              A configuração do estabelecimento continua salva do jeito que você deixou. Assine um
              plano para voltar de onde parou.
            </p>
            <div className="mt-6 flex justify-center">
              <ButtonLink href="/assinatura">Ver planos</ButtonLink>
            </div>
          </Card>
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
      {tenant === null && <EnsureActiveOrganization knownSlugs={knownSlugs} />}
      <Wizard
        tenant={tenant}
        settings={settings}
        hostSuffix={tenantHostSuffix()}
        initialPlan={initialPlan}
        prices={prices}
      />
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
