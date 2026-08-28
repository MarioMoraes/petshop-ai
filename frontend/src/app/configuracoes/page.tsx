import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { tenantHostSuffix } from '@/lib/domain'
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

  const canManageCatalog = me.permissions.includes('pet:manage_catalog')

  const [tenant, settings, species] = await Promise.all([
    serverApi().getTenant(),
    serverApi().getSettings(),
    // A aba de raças só existe para quem pode mexer nela; sem a permissão, nem a
    // lista de espécies precisa ser buscada.
    canManageCatalog ? serverApi().listSpecies() : Promise.resolve([]),
  ])

  return (
    <AppShell active="configuracoes" me={me}>
      <div className="mx-auto max-w-3xl">
        <PageHeader
          eyebrow="Estabelecimento"
          title="Configurações"
          subtitle="Dados, horário de funcionamento, políticas de agendamento, identidade visual e catálogo de raças."
        />

        <div className="mt-10">
          <SettingsForm
            tenant={tenant}
            settings={settings}
            species={species}
            hostSuffix={tenantHostSuffix()}
            canEdit={me.permissions.includes('tenant:configure')}
            canManageCatalog={canManageCatalog}
          />
        </div>
      </div>
    </AppShell>
  )
}
