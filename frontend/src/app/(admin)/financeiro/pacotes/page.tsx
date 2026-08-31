import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { FinanceiroTabs } from '../financeiro-tabs'
import { PackagesManager } from './packages-manager'

/** Catálogo de pacotes pré-pagos do estabelecimento (MOD-LEDGER-07). */

export const dynamic = 'force-dynamic'

export default async function PacotesPage() {
  const api = serverApi()
  const [me, packages, services, settings] = await Promise.all([
    api.me(),
    api.listServicePackages({ includeInactive: true }).then((result) => result.data),
    api.listServices(),
    api.getBillingSettings(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Financeiro"
        title="Pacotes pré-pagos"
        subtitle="O tutor paga N execuções adiantado e vai consumindo. É a métrica de recorrência do negócio."
      />

      <FinanceiroTabs />

      <PackagesManager
        packages={packages}
        services={services}
        defaultValidityDays={settings.defaultPackageValidityDays}
        // Gate duplo: `finance:read` abriu a tela (no layout), `finance:configure`
        // decide se ela salva. Sem a segunda, a listagem renderiza em leitura.
        canEdit={me.permissions.includes('finance:configure')}
      />
    </div>
  )
}
