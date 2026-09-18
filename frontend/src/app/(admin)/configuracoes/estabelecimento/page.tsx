import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { tenantHostSuffix } from '@/lib/domain'
import { SettingsForm } from '../settings-form'

/**
 * Configurações do estabelecimento (MOD-IDENT-08, parcial).
 *
 * As decisões que o wizard coletava uma vez, agora editáveis. Sem esta tela, mudar o
 * horário de sábado exigia refazer um onboarding que nem era reacessível depois de
 * concluído.
 *
 * O gate de permissão é duplo por construção: `tenant:read_settings` decide se a tela
 * abre, `tenant:configure` decide se ela salva. As duas checagens valem aqui pela
 * experiência — quem manda é o `requirePermission` do MOD-IDENT.
 */

export const dynamic = 'force-dynamic'

export default async function EstabelecimentoPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>
}) {
  const me = await carregarMe()

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
  /**
   * MOD-SEC-06: a trilha usa `audit:read`, que na matriz do MOD-IDENT-04 só o
   * administrador tem. É outro gate e outro leitor que o da fila de exclusão — quem
   * atende o titular não é necessariamente quem audita a equipe.
   */
  const canReadAudit = me.permissions.includes('audit:read')

  const [tenant, settings, species, deletion, terms, audit, security, support] = await Promise.all([
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
    // A aba de documentos abre para quem lê as configurações; publicar continua sendo
    // `tenant:configure`. Como a fila de exclusão, um serviço fora do ar não pode
    // derrubar a tela inteira junto com a aba.
    serverApi()
      .listTermVersions()
      .catch(() => ({ versions: [] })),
    // A trilha é moldura, como a fila de exclusão: uma consulta lenta ou fora do ar não
    // pode derrubar as Configurações inteiras junto com a aba.
    canReadAudit
      ? serverApi()
          .listAuditLogs({ limit: 50 })
          .catch(() => ({ items: [], nextCursor: null }))
      : Promise.resolve({ items: [], nextCursor: null }),
    canReadAudit
      ? serverApi()
          .summarizeSecurityEvents()
          .catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] }),
    /**
     * MOD-ADMIN-02: os pedidos de acesso da equipe PetShop AI.
     *
     * Sem gate próprio — a rota exige `tenant:read_settings`, a mesma permissão que abre
     * esta tela. Como a fila de exclusão e a trilha, é moldura: uma falha de leitura não
     * pode derrubar as Configurações inteiras junto com a aba.
     */
    serverApi()
      .listSupportAccess()
      .catch(() => ({ items: [] })),
  ])

  const { aba } = await searchParams

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/configuracoes" className="hover:underline">
            ← Configurações
          </Link>
        }
        title="Estabelecimento"
        subtitle="Dados, horário de funcionamento, políticas de agendamento, identidade visual, catálogo de raças, privacidade e trilha de auditoria."
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
          termVersions={terms.versions}
          auditLogs={audit.items}
          auditCursor={audit.nextCursor}
          securitySummary={security.items}
          canReadAudit={canReadAudit}
          supportGrants={support.items}
          abaInicial={aba}
        />
      </div>
    </>
  )
}
