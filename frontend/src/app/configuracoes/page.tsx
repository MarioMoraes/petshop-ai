import { redirect } from 'next/navigation'
import { AppHeader, trialDaysLeftOf } from '@/components/app-header'
import { PageHeader, Shell } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { SettingsForm } from './settings-form'

/**
 * Configurações do estabelecimento (MOD-IDENT-08, parcial).
 *
 * As decisões que o wizard coletava uma vez, agora editáveis. Sem esta tela, mudar o
 * horário de sábado exigia refazer um onboarding que nem era reacessível depois de
 * concluído.
 *
 * O gate de permissão é duplo por construção: `tenant:read_settings` decide se a tela
 * abre, `tenant:configure` decide se ela salva. As duas checagens valem aqui pela
 * experiência — quem manda é o `requirePermission` do identity-service.
 */

export const dynamic = 'force-dynamic'

export default async function ConfiguracoesPage() {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  // Sem sequer poder ler, a tela não existe para este perfil. Voltar ao início é mais
  // honesto que um 403 numa rota que o menu nem deveria ter oferecido.
  if (!me.permissions.includes('tenant:read_settings')) redirect('/dashboard')

  const [tenant, settings] = await Promise.all([
    serverApi().getTenant(),
    serverApi().getSettings(),
  ])

  return (
    <Shell>
      <AppHeader
        active="configuracoes"
        canReadSettings
        trialDaysLeft={trialDaysLeftOf(me.currentTenant.trialEndsAt)}
      />

      <main className="flex-1 px-6 pb-16 pt-8 sm:px-10">
        <div className="mx-auto max-w-3xl">
          <PageHeader
            eyebrow="Estabelecimento"
            title="Configurações"
            subtitle="Dados, horário de funcionamento, políticas de agendamento e identidade visual."
          />

          <div className="mt-10">
            <SettingsForm
              tenant={tenant}
              settings={settings}
              canEdit={me.permissions.includes('tenant:configure')}
            />
          </div>
        </div>
      </main>
    </Shell>
  )
}
