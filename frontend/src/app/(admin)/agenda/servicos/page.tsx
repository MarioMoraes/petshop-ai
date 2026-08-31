import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { AgendaTabs } from '../agenda-tabs'
import { ServicesManager } from './services-manager'

/**
 * Catálogo de serviços (MOD-AGENDA-01).
 *
 * A tela existe para uma coisa acima de todas: **fechar os buracos de preço**. Um
 * serviço sem preço para o porte GIGANTE não é um detalhe de cadastro — é um 422 na
 * cara da recepção com o tutor no balcão (AC-02). Por isso a lista destaca o que está
 * incompleto antes de qualquer outra informação.
 *
 * `includeInactive` é sempre verdadeiro aqui: esta é a tela de gestão, e serviço
 * desativado precisa aparecer para poder voltar.
 */

export const dynamic = 'force-dynamic'

export default async function ServicosPage() {
  const [services, sizes] = await Promise.all([
    serverApi().listServices(true),
    serverApi().listSizes(),
  ])

  const incomplete = services.filter(
    (service) => service.active && service.pricing.length < sizes.length,
  ).length

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agenda"
        title="Serviços"
        subtitle={
          incomplete > 0
            ? `${incomplete} ${incomplete === 1 ? 'serviço está' : 'serviços estão'} sem preço para algum porte`
            : `${services.filter((s) => s.active).length} serviços ativos`
        }
      />

      <AgendaTabs />

      <ServicesManager services={services} sizes={sizes} />
    </div>
  )
}
