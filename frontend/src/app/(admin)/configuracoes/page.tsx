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

export default async function ConfiguracoesPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>
}) {
  const me = await serverApi().me()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  // Sem sequer poder ler, a tela não existe para este perfil. Voltar ao início é mais
  // honesto que um 403 numa rota que o menu nem deveria ter oferecido.
  if (!me.permissions.includes('tenant:read_settings')) redirect('/dashboard')

  const canManageCatalog = me.permissions.includes('pet:manage_catalog')
  /**
   * MOD-PORTAL-09: a fila de exclusão usa o gate da anonimização, e não o de leitura do
   * tutor. A aba é uma lista de decisões sobre apagar cadastro — mostrá-la a quem não pode
   * tomá-las produziria trabalho visível e não resolvível. É o mesmo recorte do sino.
   */
  const canResolveDeletions = me.permissions.includes('tutor:delete')

  const [tenant, settings, species, deletion] = await Promise.all([
    serverApi().getTenant(),
    serverApi().getSettings(),
    // A aba de raças só existe para quem pode mexer nela; sem a permissão, nem a
    // lista de espécies precisa ser buscada.
    canManageCatalog ? serverApi().listSpecies() : Promise.resolve([]),
    canResolveDeletions
      ? serverApi()
          .listDeletionRequests({ limit: 50 })
          // A fila é moldura de uma tela que existe para outra coisa: um tutor-service
          // fora do ar não pode derrubar as Configurações inteiras junto com ela.
          .catch(() => ({ items: [], total: 0, page: 1, limit: 50 }))
      : Promise.resolve({ items: [], total: 0, page: 1, limit: 50 }),
  ])

  const { aba } = await searchParams

  return (
    <AppShell active="configuracoes" me={me}>
      <div className="mx-auto max-w-3xl">
        <PageHeader
          eyebrow="Estabelecimento"
          title="Configurações"
          subtitle="Dados, horário de funcionamento, políticas de agendamento, identidade visual, catálogo de raças e pedidos de privacidade."
        />

        <div className="mt-10">
          <SettingsForm
            tenant={tenant}
            settings={settings}
            species={species}
            hostSuffix={tenantHostSuffix()}
            canEdit={me.permissions.includes('tenant:configure')}
            canManageCatalog={canManageCatalog}
            deletionRequests={deletion.items}
            canResolveDeletions={canResolveDeletions}
            abaInicial={aba}
          />
        </div>
      </div>
    </AppShell>
  )
}
