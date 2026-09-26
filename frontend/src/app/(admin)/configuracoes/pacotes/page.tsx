import { redirect } from 'next/navigation'
import { ButtonLink } from '@/components/links'
import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { PackagesManager } from './packages-manager'

/**
 * Catálogo de pacotes pré-pagos do estabelecimento (MOD-LEDGER-07).
 *
 * Mora em Configurações, e não no Financeiro: um pacote é catálogo de serviço — N
 * execuções de um banho, com preço e validade —, ajustado de vez em quando, e não o
 * dinheiro do dia. O saldo de pacote de cada tutor continua na ficha dele.
 */

export const dynamic = 'force-dynamic'

export default async function PacotesPage() {
  const api = serverApi()
  const [me, packages, services, settings] = await Promise.all([
    api.me(),
    api.listServicePackages({ includeInactive: true }).then((result) => result.data),
    api.listServices(),
    api.getBillingSettings(),
  ])

  // O gate que vinha do layout do Financeiro. `finance:read` abre a tela; o
  // `finance:configure` abaixo decide se ela salva.
  if (!me.permissions.includes('finance:read')) redirect('/configuracoes')

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configurações"
        title="Pacotes pré-pagos"
        subtitle="O tutor paga N execuções adiantado e vai consumindo. É a métrica de recorrência do negócio."
        actions={
          <ButtonLink href="/configuracoes" variant="ghost">
            Voltar
          </ButtonLink>
        }
      />

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
